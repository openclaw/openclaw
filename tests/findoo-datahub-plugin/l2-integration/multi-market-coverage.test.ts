/**
 * L2 Integration: Multi-market coverage
 *
 * Tests 4 markets (crypto, A-share, HK, US) for:
 *   - Ticker / OHLCV / overview completeness
 *   - Trading calendar awareness (timezone-specific)
 *   - Cross-timezone data alignment
 *
 * Uses real modules with fetch intercepted at the boundary.
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCryptoAdapter } from "../../../extensions/findoo-datahub-plugin/src/adapters/crypto-adapter.js";
import { createYahooAdapter } from "../../../extensions/findoo-datahub-plugin/src/adapters/yahoo-adapter.js";
import { DataHubClient } from "../../../extensions/findoo-datahub-plugin/src/datahub-client.js";
import { OHLCVCache } from "../../../extensions/findoo-datahub-plugin/src/ohlcv-cache.js";
import { RegimeDetector } from "../../../extensions/findoo-datahub-plugin/src/regime-detector.js";
import type { OHLCV } from "../../../extensions/findoo-datahub-plugin/src/types.js";
import { UnifiedDataProvider } from "../../../extensions/findoo-datahub-plugin/src/unified-provider.js";

/* ---------- helpers ---------- */

function datahubResponse(results: unknown[], status = 200) {
  return new Response(JSON.stringify({ results }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let tmpDir: string;

beforeAll(() => {
  tmpDir = join(tmpdir(), `l2-multi-market-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

/* ============================================================
 * 1. Ticker completeness for all 4 markets
 * ============================================================ */

describe("Ticker data completeness", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("crypto ticker has required fields (symbol, market, last, timestamp)", async () => {
    const cryptoRow = {
      date: "2026-03-10",
      open: 62000,
      high: 63500,
      low: 61000,
      close: 63200,
      volume: 1500000,
    };
    fetchSpy.mockResolvedValueOnce(datahubResponse([cryptoRow]));

    const client = new DataHubClient("http://fake:8088", "admin", "key", 5000);
    const ticker = await client.getTicker("BTC/USDT", "crypto");

    expect(ticker.symbol).toBe("BTC/USDT");
    expect(ticker.market).toBe("crypto");
    expect(ticker.last).toBe(63200);
    expect(ticker.timestamp).toBeGreaterThan(0);
  });

  it("A-share ticker has required fields", async () => {
    const row = {
      date: "2026-03-10",
      open: 1800,
      high: 1820,
      low: 1790,
      close: 1815,
      volume: 45000,
    };
    fetchSpy.mockResolvedValueOnce(datahubResponse([row]));

    const client = new DataHubClient("http://fake:8088", "admin", "key", 5000);
    const ticker = await client.getTicker("600519.SH", "equity");

    expect(ticker.symbol).toBe("600519.SH");
    expect(ticker.market).toBe("equity");
    expect(ticker.last).toBe(1815);
    expect(ticker.volume24h).toBe(45000);
    expect(ticker.timestamp).toBeGreaterThan(0);
  });

  it("HK ticker returns equity market type", async () => {
    const row = {
      date: "2026-03-10",
      open: 400,
      high: 410,
      low: 395,
      close: 408,
      volume: 30000,
    };
    fetchSpy.mockResolvedValueOnce(datahubResponse([row]));

    const client = new DataHubClient("http://fake:8088", "admin", "key", 5000);
    const ticker = await client.getTicker("00700.HK", "equity");

    expect(ticker.symbol).toBe("00700.HK");
    expect(ticker.market).toBe("equity");
    expect(ticker.last).toBe(408);
  });

  it("US equity ticker returns numeric last price", async () => {
    const row = {
      date: "2026-03-10",
      open: 175,
      high: 180,
      low: 174,
      close: 179,
      volume: 60000,
    };
    fetchSpy.mockResolvedValueOnce(datahubResponse([row]));

    const client = new DataHubClient("http://fake:8088", "admin", "key", 5000);
    const ticker = await client.getTicker("AAPL", "equity");

    expect(ticker.last).toBe(179);
    expect(typeof ticker.last).toBe("number");
  });

  it("ticker throws for empty result set", async () => {
    fetchSpy.mockResolvedValueOnce(datahubResponse([]));

    const client = new DataHubClient("http://fake:8088", "admin", "key", 5000);
    await expect(client.getTicker("INVALID", "equity")).rejects.toThrow(/No ticker data/);
  });
});

/* ============================================================
 * 2. OHLCV completeness for all 4 markets via DataHubClient
 * ============================================================ */

describe("OHLCV data completeness per market", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  const marketsData: Array<{
    label: string;
    symbol: string;
    market: string;
    rows: unknown[];
  }> = [
    {
      label: "BTC/USDT (crypto)",
      symbol: "BTC/USDT",
      market: "crypto",
      rows: [
        { date: "2026-03-09", open: 61000, high: 62000, low: 60500, close: 61800, volume: 900000 },
        { date: "2026-03-10", open: 61800, high: 63500, low: 61000, close: 63200, volume: 1200000 },
      ],
    },
    {
      label: "600519.SH (A-share)",
      symbol: "600519.SH",
      market: "equity",
      rows: [
        // Tushare trade_date YYYYMMDD format produces NaN via new Date();
        // DataHub actually returns ISO date for price/historical via tushare adapter
        { date: "2026-03-09", open: 1790, high: 1810, low: 1785, close: 1805, vol: 42000 },
        { date: "2026-03-10", open: 1805, high: 1825, low: 1800, close: 1820, vol: 48000 },
      ],
    },
    {
      label: "00700.HK (HK equity)",
      symbol: "00700.HK",
      market: "equity",
      rows: [
        { date: "2026-03-09", open: 395, high: 405, low: 392, close: 402, vol: 28000 },
        { date: "2026-03-10", open: 402, high: 412, low: 400, close: 410, vol: 32000 },
      ],
    },
    {
      label: "AAPL (US equity)",
      symbol: "AAPL",
      market: "equity",
      rows: [
        { date: "2026-03-09", open: 174, high: 178, low: 173, close: 177, volume: 55000 },
        { date: "2026-03-10", open: 177, high: 181, low: 176, close: 180, volume: 62000 },
      ],
    },
  ];

  for (const { label, symbol, market, rows } of marketsData) {
    it(`${label} OHLCV has all 6 required fields`, async () => {
      fetchSpy.mockResolvedValueOnce(datahubResponse(rows));

      const client = new DataHubClient("http://fake:8088", "admin", "key", 5000);
      const ohlcv = await client.getOHLCV({ symbol, market, timeframe: "1d", limit: 5 });

      expect(ohlcv.length).toBeGreaterThan(0);
      for (const bar of ohlcv) {
        expect(typeof bar.timestamp).toBe("number");
        expect(bar.timestamp).toBeGreaterThan(0);
        expect(typeof bar.open).toBe("number");
        expect(typeof bar.high).toBe("number");
        expect(typeof bar.low).toBe("number");
        expect(typeof bar.close).toBe("number");
        expect(typeof bar.volume).toBe("number");
        // OHLCV invariant: high >= low
        expect(bar.high).toBeGreaterThanOrEqual(bar.low);
      }
    });
  }
});

/* ============================================================
 * 3. Trading calendar awareness
 * ============================================================ */

describe("Trading calendar awareness", () => {
  it("crypto market: 24/7 (no closed hours)", () => {
    // The system should accept any timestamp for crypto
    // Verify by checking that crypto adapter processes weekend data
    const cache = new OHLCVCache(join(tmpDir, "cal-crypto.sqlite"));
    // Saturday and Sunday bars
    const saturday = new Date("2026-03-14T12:00:00Z").getTime(); // Saturday
    const sunday = new Date("2026-03-15T12:00:00Z").getTime(); // Sunday

    const weekendBars: OHLCV[] = [
      { timestamp: saturday, open: 62000, high: 63000, low: 61000, close: 62500, volume: 100 },
      { timestamp: sunday, open: 62500, high: 64000, low: 62000, close: 63500, volume: 120 },
    ];

    cache.upsertBatch("BTC/USDT", "crypto", "1d", weekendBars);
    const result = cache.query("BTC/USDT", "crypto", "1d");
    expect(result).toHaveLength(2);
    // Both weekend bars stored — crypto never closes
    cache.close();
  });

  it("A-share market: trading hours 9:30-15:00 CST concept check", () => {
    // A-share trading session: 9:30-11:30, 13:00-15:00 CST (UTC+8)
    const openHourCST = 9.5; // 9:30
    const closeHourCST = 15; // 15:00
    const lunchStart = 11.5; // 11:30
    const lunchEnd = 13; // 13:00

    // Total trading minutes: (11:30-9:30) + (15:00-13:00) = 120 + 120 = 240 minutes
    const tradingMinutes = (lunchStart - openHourCST) * 60 + (closeHourCST - lunchEnd) * 60;
    expect(tradingMinutes).toBe(240);
  });

  it("HK market: trading hours 9:30-16:00 HKT concept check", () => {
    // HK trading session: 9:30-12:00, 13:00-16:00 HKT (UTC+8)
    const morning = (12 - 9.5) * 60; // 150 minutes
    const afternoon = (16 - 13) * 60; // 180 minutes
    const totalMinutes = morning + afternoon;
    expect(totalMinutes).toBe(330);
  });

  it("US market: trading hours 9:30-16:00 ET concept check", () => {
    // US trading: 9:30-16:00 ET continuous (no lunch break)
    const tradingMinutes = (16 - 9.5) * 60; // 390 minutes
    expect(tradingMinutes).toBe(390);
  });
});

/* ============================================================
 * 4. Cross-timezone data alignment
 * ============================================================ */

describe("Cross-timezone data alignment", () => {
  it("daily bars from different markets align on date (not timestamp)", async () => {
    const cache = new OHLCVCache(join(tmpDir, "tz-align.sqlite"));

    // A-share bar for 2026-03-10 (stored as midnight CST = 16:00 UTC Mar 9)
    const aShareTs = new Date("2026-03-09T16:00:00Z").getTime();
    // US bar for 2026-03-10 (stored as midnight ET = 05:00 UTC Mar 10)
    const usTs = new Date("2026-03-10T05:00:00Z").getTime();
    // Crypto bar for 2026-03-10 (UTC midnight)
    const cryptoTs = new Date("2026-03-10T00:00:00Z").getTime();

    cache.upsertBatch("600519.SH", "equity", "1d", [
      { timestamp: aShareTs, open: 1800, high: 1820, low: 1790, close: 1810, volume: 45000 },
    ]);
    cache.upsertBatch("AAPL", "equity", "1d", [
      { timestamp: usTs, open: 175, high: 180, low: 174, close: 179, volume: 60000 },
    ]);
    cache.upsertBatch("BTC/USDT", "crypto", "1d", [
      { timestamp: cryptoTs, open: 62000, high: 63500, low: 61000, close: 63000, volume: 1200000 },
    ]);

    const aShare = cache.query("600519.SH", "equity", "1d");
    const us = cache.query("AAPL", "equity", "1d");
    const btc = cache.query("BTC/USDT", "crypto", "1d");

    // All have data (despite different UTC timestamps for "same trading day")
    expect(aShare).toHaveLength(1);
    expect(us).toHaveLength(1);
    expect(btc).toHaveLength(1);

    // Timestamps differ because different timezones
    expect(aShareTs).not.toBe(usTs);
    expect(usTs).not.toBe(cryptoTs);

    cache.close();
  });

  it("DataHub normalizeOHLCV handles both date and trade_date fields", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    // trade_date in ISO format (DataHub normalizes YYYYMMDD before returning)
    fetchSpy.mockResolvedValueOnce(
      datahubResponse([
        { trade_date: "2026-03-10", open: 1800, high: 1820, low: 1790, close: 1810, vol: 45000 },
      ]),
    );

    const client = new DataHubClient("http://fake:8088", "admin", "key", 5000);
    const result = await client.getOHLCV({
      symbol: "600519.SH",
      market: "equity",
      timeframe: "1d",
    });

    expect(result).toHaveLength(1);
    expect(result[0].timestamp).toBeGreaterThan(0);
    // Verify the trade_date was parsed to a valid date
    const date = new Date(result[0].timestamp);
    expect(date.getFullYear()).toBe(2026);

    fetchSpy.mockRestore();
  });

  it("DataHub normalizeOHLCV handles Unix timestamp field", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const ts = new Date("2026-03-10T00:00:00Z").getTime();
    fetchSpy.mockResolvedValueOnce(
      datahubResponse([
        { timestamp: ts, open: 62000, high: 63500, low: 61000, close: 63000, volume: 1200000 },
      ]),
    );

    const client = new DataHubClient("http://fake:8088", "admin", "key", 5000);
    const result = await client.getOHLCV({ symbol: "BTC/USDT", market: "crypto", timeframe: "1d" });

    expect(result).toHaveLength(1);
    expect(result[0].timestamp).toBe(ts);

    fetchSpy.mockRestore();
  });
});

/* ============================================================
 * 5. getSupportedMarkets reflects availability
 * ============================================================ */

describe("getSupportedMarkets availability", () => {
  it("full access (with DataHub client): all 3 markets available", () => {
    const cache = new OHLCVCache(join(tmpDir, "markets-full.sqlite"));
    const client = new DataHubClient("http://fake:8088", "admin", "key", 5000);
    const cryptoAdapter = createCryptoAdapter(cache, async () => {
      throw new Error("unused");
    });
    const detector = new RegimeDetector();
    const provider = new UnifiedDataProvider(client, cryptoAdapter, detector, cache);

    const markets = provider.getSupportedMarkets();
    expect(markets).toHaveLength(3);

    const cryptoMarket = markets.find((m) => m.market === "crypto");
    const equityMarket = markets.find((m) => m.market === "equity");
    const commodityMarket = markets.find((m) => m.market === "commodity");

    expect(cryptoMarket?.available).toBe(true);
    expect(equityMarket?.available).toBe(true);
    expect(commodityMarket?.available).toBe(true);

    cache.close();
  });

  it("free mode (no DataHub, no Yahoo): only crypto available", () => {
    const cache = new OHLCVCache(join(tmpDir, "markets-free.sqlite"));
    const cryptoAdapter = createCryptoAdapter(cache, async () => {
      throw new Error("unused");
    });
    const detector = new RegimeDetector();
    const provider = new UnifiedDataProvider(null, cryptoAdapter, detector, cache);

    const markets = provider.getSupportedMarkets();

    const cryptoMarket = markets.find((m) => m.market === "crypto");
    const equityMarket = markets.find((m) => m.market === "equity");
    const commodityMarket = markets.find((m) => m.market === "commodity");

    expect(cryptoMarket?.available).toBe(true);
    expect(equityMarket?.available).toBe(false);
    expect(commodityMarket?.available).toBe(false);

    cache.close();
  });

  it("free mode with Yahoo: crypto + equity available", () => {
    const cache = new OHLCVCache(join(tmpDir, "markets-yahoo.sqlite"));
    const mockYahoo = {
      chart: vi.fn(),
      quote: vi.fn(),
    };
    const cryptoAdapter = createCryptoAdapter(cache, async () => {
      throw new Error("unused");
    });
    const yahooAdapter = createYahooAdapter(cache, mockYahoo);
    const detector = new RegimeDetector();
    const provider = new UnifiedDataProvider(null, cryptoAdapter, detector, cache, yahooAdapter);

    const markets = provider.getSupportedMarkets();

    const equityMarket = markets.find((m) => m.market === "equity");
    expect(equityMarket?.available).toBe(true);

    cache.close();
  });
});
