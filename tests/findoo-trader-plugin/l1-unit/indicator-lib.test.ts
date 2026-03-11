/**
 * L1 Unit Tests — Technical Indicator Library
 *
 * Covers:
 * - SMA: correctness, NaN warm-up, empty input
 * - EMA: correctness with SMA seed, NaN warm-up
 * - RSI: Wilder's smoothing, overbought/oversold values, all-gain/all-loss
 * - MACD: line, signal, histogram calculation
 * - Bollinger Bands: middle = SMA, upper/lower = middle ± stdDev * multiplier
 * - ATR: True Range computation, Wilder's smoothing
 * - Data insufficient handling
 */

import { describe, it, expect } from "vitest";
import {
  sma,
  ema,
  rsi,
  macd,
  bollingerBands,
  atr,
} from "../../../extensions/findoo-trader-plugin/src/strategy/indicators.js";

// Helper: generate an array of linearly spaced values
function linspace(start: number, end: number, n: number): number[] {
  const step = (end - start) / (n - 1);
  return Array.from({ length: n }, (_, i) => start + step * i);
}

describe("SMA — Simple Moving Average", () => {
  it("should compute correct SMA for a known sequence", () => {
    const data = [2, 4, 6, 8, 10];
    const result = sma(data, 3);

    expect(result).toHaveLength(5);
    expect(result[0]).toBeNaN(); // not enough data
    expect(result[1]).toBeNaN();
    expect(result[2]).toBeCloseTo(4, 6); // (2+4+6)/3
    expect(result[3]).toBeCloseTo(6, 6); // (4+6+8)/3
    expect(result[4]).toBeCloseTo(8, 6); // (6+8+10)/3
  });

  it("should return NaN for all indices when period > data length", () => {
    const data = [1, 2, 3];
    const result = sma(data, 5);
    for (const v of result) {
      expect(v).toBeNaN();
    }
  });

  it("should return empty array for empty input", () => {
    expect(sma([], 5)).toEqual([]);
  });

  it("should return SMA(1) = data itself", () => {
    const data = [10, 20, 30];
    const result = sma(data, 1);
    expect(result[0]).toBeCloseTo(10, 6);
    expect(result[1]).toBeCloseTo(20, 6);
    expect(result[2]).toBeCloseTo(30, 6);
  });
});

describe("EMA — Exponential Moving Average", () => {
  it("should seed first EMA value with SMA of first period values", () => {
    const data = [10, 20, 30, 40, 50];
    const result = ema(data, 3);

    expect(result[0]).toBeNaN();
    expect(result[1]).toBeNaN();
    // Seed = SMA(3) of [10,20,30] = 20
    expect(result[2]).toBeCloseTo(20, 6);
  });

  it("should apply EMA formula after seed: EMA = close * k + prev * (1-k)", () => {
    const data = [10, 20, 30, 40, 50];
    const result = ema(data, 3);
    const _k = 2 / (3 + 1); // 0.5

    // result[2] = 20 (seed)
    // result[3] = 40 * 0.5 + 20 * 0.5 = 30
    expect(result[3]).toBeCloseTo(30, 6);
    // result[4] = 50 * 0.5 + 30 * 0.5 = 40
    expect(result[4]).toBeCloseTo(40, 6);
  });

  it("should return all NaN when period > data length", () => {
    const data = [1, 2];
    const result = ema(data, 5);
    for (const v of result) {
      expect(v).toBeNaN();
    }
  });

  it("should return empty array for empty input", () => {
    expect(ema([], 5)).toEqual([]);
  });
});

describe("RSI — Relative Strength Index", () => {
  it("should return 100 when all changes are gains", () => {
    // Monotonically increasing → all gains, no losses → RSI = 100
    const data = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
    const result = rsi(data, 5);
    // First valid RSI at index 5
    expect(result[5]).toBeCloseTo(100, 4);
  });

  it("should return 0 when all changes are losses", () => {
    // Monotonically decreasing → all losses, no gains → RSI = 0
    const data = [20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10];
    const result = rsi(data, 5);
    expect(result[5]).toBeCloseTo(0, 4);
  });

  it("should return values in [0, 100] range", () => {
    const data = [
      44, 44.34, 44.09, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28,
      46.28, 46.0, 46.03, 46.41, 46.22, 45.64,
    ];
    const result = rsi(data, 14);

    for (const v of result) {
      if (!Number.isNaN(v)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });

  it("should have NaN for warm-up period (indices 0..period)", () => {
    const data = linspace(100, 110, 20);
    const result = rsi(data, 14);

    for (let i = 0; i < 14; i++) {
      expect(result[i]).toBeNaN();
    }
    // First valid at index 14
    expect(Number.isNaN(result[14])).toBe(false);
  });

  it("should return all NaN when data is shorter than period+1", () => {
    const data = [10, 11, 12];
    const result = rsi(data, 14);
    for (const v of result) {
      expect(v).toBeNaN();
    }
  });
});

describe("MACD — Moving Average Convergence Divergence", () => {
  it("should return empty arrays for empty input", () => {
    const result = macd([]);
    expect(result.macd).toEqual([]);
    expect(result.signal).toEqual([]);
    expect(result.histogram).toEqual([]);
  });

  it("should compute MACD line as fastEMA - slowEMA", () => {
    // Generate enough data for default params (12, 26, 9)
    const data = linspace(100, 200, 50);
    const result = macd(data, 12, 26, 9);

    // MACD line should have valid values after slow EMA warmup (index 25)
    const fastEmaVals = ema(data, 12);
    const slowEmaVals = ema(data, 26);

    for (let i = 25; i < 50; i++) {
      if (!Number.isNaN(fastEmaVals[i]) && !Number.isNaN(slowEmaVals[i])) {
        expect(result.macd[i]).toBeCloseTo(fastEmaVals[i] - slowEmaVals[i], 6);
      }
    }
  });

  it("should have NaN MACD during warmup period", () => {
    const data = linspace(100, 200, 50);
    const result = macd(data, 12, 26, 9);

    // Indices 0..24 should be NaN (slow EMA period - 1 = 25)
    for (let i = 0; i < 25; i++) {
      expect(result.macd[i]).toBeNaN();
    }
  });

  it("histogram should equal MACD line - signal line where both defined", () => {
    const data = linspace(50, 150, 60);
    const result = macd(data, 12, 26, 9);

    for (let i = 0; i < 60; i++) {
      if (!Number.isNaN(result.histogram[i]) && !Number.isNaN(result.signal[i])) {
        expect(result.histogram[i]).toBeCloseTo(result.macd[i] - result.signal[i], 6);
      }
    }
  });
});

describe("Bollinger Bands", () => {
  it("should return empty arrays for empty input", () => {
    const result = bollingerBands([]);
    expect(result.upper).toEqual([]);
    expect(result.middle).toEqual([]);
    expect(result.lower).toEqual([]);
  });

  it("middle band should equal SMA", () => {
    const data = linspace(100, 120, 30);
    const result = bollingerBands(data, 20, 2);
    const smaVals = sma(data, 20);

    for (let i = 0; i < 30; i++) {
      if (!Number.isNaN(smaVals[i])) {
        expect(result.middle[i]).toBeCloseTo(smaVals[i], 6);
      }
    }
  });

  it("should have upper > middle > lower where defined", () => {
    const data = [
      100, 102, 98, 103, 97, 105, 99, 101, 104, 96, 100, 102, 98, 103, 97, 105, 99, 101, 104, 96,
      100,
    ];
    const result = bollingerBands(data, 10, 2);

    for (let i = 0; i < data.length; i++) {
      if (!Number.isNaN(result.upper[i])) {
        expect(result.upper[i]).toBeGreaterThan(result.middle[i]);
        expect(result.middle[i]).toBeGreaterThan(result.lower[i]);
      }
    }
  });

  it("bands should be symmetric around middle", () => {
    const data = linspace(100, 120, 25);
    const result = bollingerBands(data, 20, 2);

    for (let i = 19; i < 25; i++) {
      const upperDiff = result.upper[i] - result.middle[i];
      const lowerDiff = result.middle[i] - result.lower[i];
      expect(upperDiff).toBeCloseTo(lowerDiff, 6);
    }
  });

  it("should have NaN during warm-up period", () => {
    const data = linspace(100, 110, 10);
    const result = bollingerBands(data, 20, 2);

    for (let i = 0; i < 10; i++) {
      expect(result.upper[i]).toBeNaN();
      expect(result.lower[i]).toBeNaN();
    }
  });
});

describe("ATR — Average True Range", () => {
  it("should return empty for empty input", () => {
    expect(atr([], [], [])).toEqual([]);
  });

  it("should have NaN during warm-up period", () => {
    const highs = [12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
    const lows = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
    const closes = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
    const result = atr(highs, lows, closes, 5);

    // NaN for indices 0..4
    for (let i = 0; i < 5; i++) {
      expect(result[i]).toBeNaN();
    }
    // First valid at index 5
    expect(Number.isNaN(result[5])).toBe(false);
  });

  it("should compute correct ATR for constant range bars", () => {
    // Bars with constant H-L range of 2, no gaps
    const n = 20;
    const highs = Array.from({ length: n }, (_, i) => 101 + i);
    const lows = Array.from({ length: n }, (_, i) => 99 + i);
    const closes = Array.from({ length: n }, (_, i) => 100 + i);
    const result = atr(highs, lows, closes, 5);

    // With constant range and sequential closes, TR ≈ 2 for all bars
    // ATR should converge to ~2
    for (let i = 10; i < n; i++) {
      expect(result[i]).toBeCloseTo(2, 0);
    }
  });

  it("should return all NaN when data is shorter than period+1", () => {
    const result = atr([12, 13], [10, 11], [11, 12], 14);
    for (const v of result) {
      expect(v).toBeNaN();
    }
  });
});
