import type { OHLCV } from "../../extensions/fin-shared-types/src/types.js";

/**
 * Generate synthetic OHLCV data for testing.
 * Uses deterministic pseudo-random (sine-based) for reproducibility.
 */
export function generateOHLCV(opts: {
  bars: number;
  startPrice: number;
  trend: "bull" | "bear" | "sideways" | "volatile";
  volatility?: number;
}): OHLCV[] {
  const { bars, startPrice, trend, volatility = 0.02 } = opts;
  const data: OHLCV[] = [];
  let price = startPrice;
  const baseTimestamp = 1_700_000_000_000;

  for (let i = 0; i < bars; i++) {
    // Deterministic pseudo-random via sine hash (reproducible without seed)
    const pseudoRandom = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
    const noise = (pseudoRandom - Math.floor(pseudoRandom) - 0.5) * 2;

    let drift = 0;
    switch (trend) {
      case "bull":
        drift = 0.002;
        break;
      case "bear":
        drift = -0.002;
        break;
      case "sideways":
        drift = 0;
        break;
      case "volatile":
        drift = noise * 0.005;
        break;
    }

    const change = drift + noise * volatility;
    price = price * (1 + change);
    if (price <= 0) {
      price = 0.01;
    }

    const high = price * (1 + Math.abs(noise) * volatility * 0.5);
    const low = price * (1 - Math.abs(noise) * volatility * 0.5);

    data.push({
      timestamp: baseTimestamp + i * 86_400_000,
      open: i === 0 ? startPrice : data[i - 1].close,
      high: Math.max(price, high),
      low: Math.min(price, low),
      close: price,
      volume: 1000 + Math.abs(noise) * 500,
    });
  }

  return data;
}

/**
 * Generate linear OHLCV data (fully deterministic, no randomness).
 * Price moves linearly from startPrice to endPrice over `bars` bars.
 */
export function generateLinearOHLCV(bars: number, startPrice: number, endPrice: number): OHLCV[] {
  const data: OHLCV[] = [];
  const baseTimestamp = 1_700_000_000_000;

  for (let i = 0; i < bars; i++) {
    const price = startPrice + ((endPrice - startPrice) * i) / (bars - 1);
    data.push({
      timestamp: baseTimestamp + i * 86_400_000,
      open: price,
      high: price * 1.001,
      low: price * 0.999,
      close: price,
      volume: 1000,
    });
  }

  return data;
}

/**
 * Generate an equity curve with a fixed daily return and optional noise.
 */
export function generateEquityCurve(opts: {
  initial: number;
  days: number;
  dailyReturn: number;
  noise?: number;
}): number[] {
  const { initial, days, dailyReturn, noise = 0 } = opts;
  const curve: number[] = [initial];

  for (let i = 1; i < days; i++) {
    const pseudoRandom = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
    const n = (pseudoRandom - Math.floor(pseudoRandom) - 0.5) * 2 * noise;
    const ret = dailyReturn + n;
    curve.push(curve[i - 1] * (1 + ret));
  }

  return curve;
}
