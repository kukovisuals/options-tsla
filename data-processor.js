/**
 * OPTIONS FLOW DATA PROCESSOR
 * Reads data.json and computes all signals for the Three.js visualizer
 */

export class OptionsDataProcessor {
  constructor(rawData) {
    this.raw = rawData.data || rawData;
    this.strikes = {};       // keyed by strike+type
    this.minuteBuckets = {}; // keyed by strike+type, array of {minute, volume}
    this.processed = null;
  }

  process() {
    this._buildStrikeMap();
    this._buildMinuteBuckets();
    this._computeVolumeSignal();
    this._computeGreekSurfaces();
    this._computeConvictionIndex();
    this.processed = this._buildOutputStructure();
    return this.processed;
  }

  _buildStrikeMap() {
    for (const trade of this.raw) {
      if (trade.canceled) continue;

      const key = `${trade.strike}_${trade.option_type}`;

      if (!this.strikes[key]) {
        this.strikes[key] = {
          strike: parseFloat(trade.strike),
          option_type: trade.option_type,
          ask_vol: 0,
          bid_vol: 0,
          no_side_vol: 0,
          total_volume: 0,
          premium: 0,
          gamma: 0,
          theta: 0,
          delta: 0,
          vega: 0,
          implied_volatility: 0,
          open_interest: 0,
          underlying_price: 0,
          trade_count: 0,
          tags: { bullish: 0, bearish: 0, ask_side: 0, bid_side: 0 },
          trades: []
        };
      }

      const s = this.strikes[key];
      s.ask_vol         += (trade.ask_vol || 0);
      s.bid_vol         += (trade.bid_vol || 0);
      s.no_side_vol     += (trade.no_side_vol || 0);
      s.total_volume    += (trade.volume || 0);
      s.premium         += parseFloat(trade.premium || 0);
      s.gamma           += parseFloat(trade.gamma || 0);
      s.theta           += parseFloat(trade.theta || 0);
      s.delta           += parseFloat(trade.delta || 0);
      s.vega            += parseFloat(trade.vega || 0);
      s.implied_volatility += parseFloat(trade.implied_volatility || 0);
      s.open_interest   = Math.max(s.open_interest, trade.open_interest || 0);
      s.underlying_price = parseFloat(trade.underlying_price || 0);
      s.trade_count     += 1;

      for (const tag of (trade.tags || [])) {
        if (s.tags[tag] !== undefined) s.tags[tag]++;
      }

      s.trades.push(trade);
    }

    // Normalize averages
    for (const key of Object.keys(this.strikes)) {
      const s = this.strikes[key];
      if (s.trade_count > 0) {
        s.gamma            /= s.trade_count;
        s.theta            /= s.trade_count;
        s.delta            /= s.trade_count;
        s.vega             /= s.trade_count;
        s.implied_volatility /= s.trade_count;
      }
    }
  }

  _buildMinuteBuckets() {
    for (const trade of this.raw) {
      if (trade.canceled) continue;

      const key = `${trade.strike}_${trade.option_type}`;
      if (!this.minuteBuckets[key]) this.minuteBuckets[key] = {};

      const dt = new Date(trade.executed_at);
      const minuteKey = `${dt.getUTCHours()}:${String(dt.getUTCMinutes()).padStart(2, '0')}`;

      if (!this.minuteBuckets[key][minuteKey]) {
        this.minuteBuckets[key][minuteKey] = 0;
      }
      this.minuteBuckets[key][minuteKey] += (trade.volume || 0);
    }
  }

  /**
   * Volume signal: only average non-zero buckets, require >= 5 buckets,
   * flag if latest (or max recent) bucket >= 2x that average
   */
  _computeVolumeSignal() {
    for (const key of Object.keys(this.strikes)) {
      const s = this.strikes[key];
      const buckets = this.minuteBuckets[key] || {};

      const nonZeroBuckets = Object.values(buckets).filter(v => v > 0);

      s.volumeSignal = {
        bucketCount: nonZeroBuckets.length,
        qualified: false,       // meets 5-bucket minimum
        activeAvg: 0,
        peakBucket: 0,
        ratio: 0,               // peakBucket / activeAvg
        firing: false           // ratio >= 2x AND qualified
      };

      if (nonZeroBuckets.length >= 5) {
        const avg = nonZeroBuckets.reduce((a, b) => a + b, 0) / nonZeroBuckets.length;
        const peak = Math.max(...nonZeroBuckets);

        s.volumeSignal.qualified  = true;
        s.volumeSignal.activeAvg  = avg;
        s.volumeSignal.peakBucket = peak;
        s.volumeSignal.ratio      = peak / avg;
        s.volumeSignal.firing     = (peak >= 2 * avg);
      }
    }
  }

  _computeGreekSurfaces() {
    // Already averaged per strike in _buildStrikeMap
    // Just expose them cleanly for the renderer
    for (const key of Object.keys(this.strikes)) {
      const s = this.strikes[key];
      s.greeks = {
        gamma: s.gamma,
        theta: s.theta,      // negative value — burn rate
        delta: s.delta,
        vega:  s.vega,
        iv:    s.implied_volatility
      };
    }
  }

  /**
   * Conviction Index per strike:
   * (ask_vol - bid_vol) * gamma * (1 / |theta|)
   * Penalized by theta burn, amplified by gamma convexity
   */
  _computeConvictionIndex() {
    for (const key of Object.keys(this.strikes)) {
      const s = this.strikes[key];
      const netFlow   = s.ask_vol - s.bid_vol;
      const abcTheta  = Math.abs(s.theta) || 0.0001;
      s.convictionIndex = netFlow * s.gamma * (1 / abcTheta);

      // Ask aggression ratio
      const totalSide = s.ask_vol + s.bid_vol;
      s.aggressionRatio = totalSide > 0 ? s.ask_vol / totalSide : 0.5;
    }
  }

  _buildOutputStructure() {
    const allStrikes = Object.values(this.strikes);

    // Separate calls and puts
    const calls = allStrikes.filter(s => s.option_type === 'call');
    const puts  = allStrikes.filter(s => s.option_type === 'put');

    // Sort by strike ascending
    calls.sort((a, b) => a.strike - b.strike);
    puts.sort((a, b) => a.strike - b.strike);

    // Global normalization ranges for the renderer
    const allVol         = allStrikes.map(s => s.total_volume);
    const allAskVol      = allStrikes.map(s => s.ask_vol);
    const allBidVol      = allStrikes.map(s => s.bid_vol);
    const allGamma       = allStrikes.map(s => Math.abs(s.gamma));
    const allTheta       = allStrikes.map(s => Math.abs(s.theta));
    const allConviction  = allStrikes.map(s => Math.abs(s.convictionIndex));
    const allIV          = allStrikes.map(s => s.implied_volatility);

    const underlyingPrice = allStrikes[0]?.underlying_price || 0;

    return {
      calls,
      puts,
      all: allStrikes,
      underlyingPrice,
      ranges: {
        maxVolume:     Math.max(...allVol,        1),
        maxAskVol:     Math.max(...allAskVol,     1),
        maxBidVol:     Math.max(...allBidVol,     1),
        maxGamma:      Math.max(...allGamma,      0.0001),
        maxTheta:      Math.max(...allTheta,      0.0001),
        maxConviction: Math.max(...allConviction, 0.0001),
        maxIV:         Math.max(...allIV,         0.0001),
        minStrike:     Math.min(...allStrikes.map(s => s.strike)),
        maxStrike:     Math.max(...allStrikes.map(s => s.strike)),
      },
      signals: {
        firingStrikes: allStrikes.filter(s => s.volumeSignal.firing),
        topConviction: [...allStrikes]
          .sort((a, b) => Math.abs(b.convictionIndex) - Math.abs(a.convictionIndex))
          .slice(0, 5),
        dualSignal: allStrikes.filter(s =>
          s.volumeSignal.firing &&
          Math.abs(s.convictionIndex) > 0
        )
      }
    };
  }

  // Static loader — call this in the browser with fetch
  static async loadFromFile(url = './data.json') {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
    const json = await res.json();
    const processor = new OptionsDataProcessor(json);
    return processor.process();
  }
}
