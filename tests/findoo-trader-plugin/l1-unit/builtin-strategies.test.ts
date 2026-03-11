/**
 * L1 Unit Tests — Builtin Trading Strategies
 *
 * Tests signal generation for built-in strategies with synthetic OHLCV data:
 * - SMA Crossover: golden cross buy, death cross sell
 * - RSI Mean Reversion: oversold buy, overbought sell
 * - Bollinger Bands: lower band breakout buy, upper band breakout sell
 * - MACD Divergence: histogram zero-cross buy/sell
 *
 * All tests use mock StrategyContext with controllable indicator outputs.
 * No look-ahead bias verification included.
 */

import { describe, it, expect, vi } from "vitest";
import type {
  OHLCV,
  StrategyContext,
  IndicatorLib,
} from "../../../extensions/findoo-trader-plugin/src/shared/types.js";
import { createBollingerBands } from "../../../extensions/findoo-trader-plugin/src/strategy/builtin-strategies/bollinger-bands.js";
import { createMacdDivergence } from "../../../extensions/findoo-trader-plugin/src/strategy/builtin-strategies/macd-divergence.js";
import { createRsiMeanReversion } from "../../../extensions/findoo-trader-plugin/src/strategy/builtin-strategies/rsi-mean-reversion.js";
import { createSmaCrossover } from "../../../extensions/findoo-trader-plugin/src/strategy/builtin-strategies/sma-crossover.js";

// -- Helpers ------------------------------------------------------------------

function bar(close: number, o?: Partial<OHLCV>): OHLCV {
  return {
    timestamp: Date.now(),
    open: o?.open ?? close,
    high: o?.high ?? close + 1,
    low: o?.low ?? close - 1,
    close,
    volume: o?.volume ?? 1000,
  };
}

function makeCtx(overrides: {
  positions?: Array<{
    side: string;
    symbol?: string;
    quantity?: number;
    entryPrice?: number;
    currentPrice?: number;
    unrealizedPnl?: number;
  }>;
  sma?: Record<number, number[]>;
  ema?: Record<number, number[]>;
  rsi?: Record<number, number[]>;
  macd?: Record<string, { macd: number[]; signal: number[]; histogram: number[] }>;
  bollingerBands?: Record<string, { upper: number[]; middle: number[]; lower: number[] }>;
  atr?: Record<number, number[]>;
  regime?: string;
  history?: OHLCV[];
  equity?: number;
}): StrategyContext {
  const indicators: IndicatorLib = {
    sma: (period: number) => overrides.sma?.[period] ?? [],
    ema: (period: number) => overrides.ema?.[period] ?? [],
    rsi: (period: number) => overrides.rsi?.[period] ?? [],
    macd: (fast?: number, slow?: number, signal?: number) => {
      const key = `${fast ?? 12}-${slow ?? 26}-${signal ?? 9}`;
      return overrides.macd?.[key] ?? { macd: [], signal: [], histogram: [] };
    },
    bollingerBands: (period?: number, stdDev?: number) => {
      const key = `${period ?? 20}-${stdDev ?? 2}`;
      return (
        overrides.bollingerBands?.[key] ?? {
          upper: [],
          middle: [],
          lower: [],
        }
      );
    },
    atr: (period?: number) => overrides.atr?.[period ?? 14] ?? [],
  };

  return {
    portfolio: {
      equity: overrides.equity ?? 100_000,
      cash: overrides.equity ?? 100_000,
      positions: (overrides.positions ?? []) as StrategyContext["portfolio"]["positions"],
    },
    history: overrides.history ?? [],
    indicators,
    regime: (overrides.regime ?? "sideways") as StrategyContext["regime"],
    memory: new Map(),
    log: vi.fn(),
  };
}

const longPosition = {
  side: "long",
  symbol: "BTC/USDT",
  quantity: 1,
  entryPrice: 100,
  currentPrice: 100,
  unrealizedPnl: 0,
};

// =============================================================================
// SMA Crossover
// =============================================================================

describe("SMA Crossover", () => {
  const strategy = createSmaCrossover({ fastPeriod: 10, slowPeriod: 30 });

  // 1. Golden cross -> buy
  it("generates buy signal on golden cross (fast crosses above slow)", async () => {
    const ctx = makeCtx({
      sma: {
        10: [NaN, NaN, 98, 101], // prev: fast<=slow, curr: fast>slow
        30: [NaN, NaN, 100, 100],
      },
    });

    const signal = await strategy.onBar(bar(102), ctx);
    expect(signal).not.toBeNull();
    expect(signal!.action).toBe("buy");
    expect(signal!.reason).toContain("golden cross");
    expect(signal!.confidence).toBe(0.7);
  });

  // 2. Death cross -> sell
  it("generates sell signal on death cross (fast crosses below slow)", async () => {
    const ctx = makeCtx({
      sma: {
        10: [NaN, NaN, 102, 98],
        30: [NaN, NaN, 100, 100],
      },
      positions: [longPosition],
    });

    const signal = await strategy.onBar(bar(98), ctx);
    expect(signal).not.toBeNull();
    expect(signal!.action).toBe("sell");
    expect(signal!.reason).toContain("death cross");
  });

  // 3. No crossover -> null
  it("returns null when no crossover occurs (fast stays above slow)", async () => {
    const ctx = makeCtx({
      sma: {
        10: [NaN, NaN, 105, 106],
        30: [NaN, NaN, 100, 100],
      },
    });

    expect(await strategy.onBar(bar(106), ctx)).toBeNull();
  });

  // 4. Warm-up period with NaN -> null
  it("returns null during NaN warm-up period", async () => {
    const ctx = makeCtx({
      sma: { 10: [NaN, NaN], 30: [NaN, NaN] },
    });

    expect(await strategy.onBar(bar(100), ctx)).toBeNull();
  });

  // 5. Golden cross but already long -> no duplicate buy
  it("does not buy when already holding a long position", async () => {
    const ctx = makeCtx({
      sma: {
        10: [NaN, NaN, 98, 101],
        30: [NaN, NaN, 100, 100],
      },
      positions: [longPosition],
    });

    expect(await strategy.onBar(bar(101), ctx)).toBeNull();
  });

  // 6. Death cross but no position -> no sell
  it("does not sell when no long position exists", async () => {
    const ctx = makeCtx({
      sma: {
        10: [NaN, NaN, 102, 98],
        30: [NaN, NaN, 100, 100],
      },
    });

    expect(await strategy.onBar(bar(98), ctx)).toBeNull();
  });

  // 7. Custom parameters are respected
  it("accepts custom fast/slow periods", () => {
    const custom = createSmaCrossover({ fastPeriod: 5, slowPeriod: 20 });
    expect(custom.parameters.fastPeriod).toBe(5);
    expect(custom.parameters.slowPeriod).toBe(20);
  });

  // 8. No look-ahead: uses only last two SMA values
  it("uses only the last two SMA values (no look-ahead)", async () => {
    const ctx = makeCtx({
      sma: {
        10: [80, 85, 90, 95, 98, 101], // only [4],[5] matter
        30: [82, 84, 88, 92, 100, 100],
      },
    });

    const signal = await strategy.onBar(bar(102), ctx);
    expect(signal).not.toBeNull();
    expect(signal!.action).toBe("buy");
  });
});

// =============================================================================
// RSI Mean Reversion
// =============================================================================

describe("RSI Mean Reversion", () => {
  const strategy = createRsiMeanReversion({
    period: 14,
    oversold: 30,
    overbought: 70,
  });

  // 9. RSI < oversold -> buy
  it("buys when RSI drops below oversold threshold", async () => {
    const ctx = makeCtx({ rsi: { 14: [NaN, NaN, 25] } });

    const signal = await strategy.onBar(bar(100), ctx);
    expect(signal).not.toBeNull();
    expect(signal!.action).toBe("buy");
    expect(signal!.reason).toContain("oversold");
  });

  // 10. RSI > overbought with position -> sell
  it("sells when RSI rises above overbought threshold", async () => {
    const ctx = makeCtx({
      rsi: { 14: [NaN, NaN, 75] },
      positions: [longPosition],
    });

    const signal = await strategy.onBar(bar(120), ctx);
    expect(signal).not.toBeNull();
    expect(signal!.action).toBe("sell");
    expect(signal!.reason).toContain("overbought");
  });

  // 11. RSI in neutral zone -> null
  it("returns null when RSI is between 30 and 70", async () => {
    const ctx = makeCtx({ rsi: { 14: [NaN, NaN, 50] } });
    expect(await strategy.onBar(bar(100), ctx)).toBeNull();
  });

  // 12. NaN RSI -> null
  it("returns null when RSI is NaN", async () => {
    const ctx = makeCtx({ rsi: { 14: [NaN] } });
    expect(await strategy.onBar(bar(100), ctx)).toBeNull();
  });

  // 13. RSI oversold but already long -> no buy
  it("does not buy when already holding a position", async () => {
    const ctx = makeCtx({
      rsi: { 14: [25] },
      positions: [longPosition],
    });
    expect(await strategy.onBar(bar(100), ctx)).toBeNull();
  });

  // 14. RSI exactly at threshold boundaries
  it("does not buy at exactly RSI=30 (need < 30)", async () => {
    const ctx = makeCtx({ rsi: { 14: [30] } });
    expect(await strategy.onBar(bar(100), ctx)).toBeNull();
  });
});

// =============================================================================
// Bollinger Bands
// =============================================================================

describe("Bollinger Bands", () => {
  const strategy = createBollingerBands({ period: 20, stdDev: 2 });
  const bands = {
    "20-2": { upper: [110], middle: [100], lower: [90] },
  };

  // 15. Close below lower band -> buy
  it("buys when close is below lower band (oversold)", async () => {
    const ctx = makeCtx({ bollingerBands: bands });

    const signal = await strategy.onBar(bar(85), ctx); // 85 < 90
    expect(signal).not.toBeNull();
    expect(signal!.action).toBe("buy");
    expect(signal!.reason).toContain("oversold");
    expect(signal!.confidence).toBe(0.65);
  });

  // 16. Close above upper band with position -> sell
  it("sells when close is above upper band (overbought)", async () => {
    const ctx = makeCtx({
      bollingerBands: bands,
      positions: [longPosition],
    });

    const signal = await strategy.onBar(bar(115), ctx); // 115 > 110
    expect(signal).not.toBeNull();
    expect(signal!.action).toBe("sell");
    expect(signal!.reason).toContain("overbought");
  });

  // 17. Close between bands -> null
  it("returns null when close is between bands", async () => {
    const ctx = makeCtx({ bollingerBands: bands });
    expect(await strategy.onBar(bar(100), ctx)).toBeNull();
  });

  // 18. NaN bands -> null
  it("returns null when bands contain NaN", async () => {
    const ctx = makeCtx({
      bollingerBands: {
        "20-2": { upper: [NaN], middle: [NaN], lower: [NaN] },
      },
    });
    expect(await strategy.onBar(bar(100), ctx)).toBeNull();
  });

  // 19. Close exactly at lower band -> no signal (not below)
  it("does not buy when close equals exactly the lower band", async () => {
    const ctx = makeCtx({ bollingerBands: bands });
    expect(await strategy.onBar(bar(90), ctx)).toBeNull(); // 90 is not < 90
  });
});

// =============================================================================
// MACD Divergence
// =============================================================================

describe("MACD Divergence", () => {
  const strategy = createMacdDivergence();

  // 20. Histogram crosses from negative to positive -> buy
  it("buys when histogram crosses from negative to positive (bullish)", async () => {
    const ctx = makeCtx({
      macd: {
        "12-26-9": {
          macd: [0, 0],
          signal: [0, 0],
          histogram: [-0.5, 0.3],
        },
      },
    });

    const signal = await strategy.onBar(bar(100), ctx);
    expect(signal).not.toBeNull();
    expect(signal!.action).toBe("buy");
    expect(signal!.reason).toContain("bullish cross");
  });

  // 21. Histogram crosses from positive to negative with position -> sell
  it("sells when histogram crosses from positive to negative (bearish)", async () => {
    const ctx = makeCtx({
      macd: {
        "12-26-9": {
          macd: [0, 0],
          signal: [0, 0],
          histogram: [0.5, -0.3],
        },
      },
      positions: [longPosition],
    });

    const signal = await strategy.onBar(bar(100), ctx);
    expect(signal).not.toBeNull();
    expect(signal!.action).toBe("sell");
    expect(signal!.reason).toContain("bearish cross");
  });

  // 22. Histogram stays positive -> null
  it("returns null when histogram stays positive (no cross)", async () => {
    const ctx = makeCtx({
      macd: {
        "12-26-9": {
          macd: [0, 0],
          signal: [0, 0],
          histogram: [0.3, 0.5],
        },
      },
    });

    expect(await strategy.onBar(bar(100), ctx)).toBeNull();
  });

  // 23. Histogram stays negative -> null
  it("returns null when histogram stays negative (no cross)", async () => {
    const ctx = makeCtx({
      macd: {
        "12-26-9": {
          macd: [0, 0],
          signal: [0, 0],
          histogram: [-0.3, -0.5],
        },
      },
    });

    expect(await strategy.onBar(bar(100), ctx)).toBeNull();
  });

  // 24. Single histogram value (not enough history) -> null
  it("returns null when histogram has fewer than 2 values", async () => {
    const ctx = makeCtx({
      macd: {
        "12-26-9": { macd: [0], signal: [0], histogram: [0.1] },
      },
    });

    expect(await strategy.onBar(bar(100), ctx)).toBeNull();
  });

  // 25. NaN histogram -> null
  it("returns null when histogram contains NaN", async () => {
    const ctx = makeCtx({
      macd: {
        "12-26-9": {
          macd: [0, 0],
          signal: [0, 0],
          histogram: [NaN, 0.5],
        },
      },
    });

    expect(await strategy.onBar(bar(100), ctx)).toBeNull();
  });

  // 26. Histogram exactly at zero boundary: prev<0, curr=0 -> buy
  it("triggers buy when histogram crosses to exactly zero (prev < 0, curr >= 0)", async () => {
    const ctx = makeCtx({
      macd: {
        "12-26-9": {
          macd: [0, 0],
          signal: [0, 0],
          histogram: [-0.1, 0],
        },
      },
    });

    const signal = await strategy.onBar(bar(100), ctx);
    expect(signal).not.toBeNull();
    expect(signal!.action).toBe("buy");
  });

  // 27. Custom MACD parameters
  it("respects custom period parameters", () => {
    const custom = createMacdDivergence({
      fastPeriod: 8,
      slowPeriod: 21,
      signalPeriod: 5,
    });
    expect(custom.parameters.fastPeriod).toBe(8);
    expect(custom.parameters.slowPeriod).toBe(21);
    expect(custom.parameters.signalPeriod).toBe(5);
  });
});
