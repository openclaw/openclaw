/**
 * L2 Integration: DataHub data provider chain
 *
 * Tests the complete data flow through real modules (no mocks):
 *   DataHubClient -> UnifiedProvider -> OHLCVCache -> RegimeDetector
 *
 * Network calls are avoided by intercepting fetch at the boundary.
 * All other modules (cache, detector, adapters) run with real implementations.
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

function generateOHLCV(
  count: number,
  trend: "up" | "down" | "flat" | "volatile" | "crash",
  startPrice = 100,
  startTime = Date.now() - count * 3600_000,
): OHLCV[] {
  const bars: OHLCV[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    let change: number;
    switch (trend) {
      case "up":
        change = price * (0.005 + Math.random() * 0.01);
        break;
      case "down":
        change = price * -(0.005 + Math.random() * 0.01);
        break;
      case "flat":
        change = price * (Math.random() - 0.5) * 0.003;
        break;
      case "volatile":
        change = price * (Math.random() - 0.5) * 0.08;
        break;
      case "crash":
        change = price * -(0.01 + Math.random() * 0.015);
        break;
    }
    const open = price;
    price = price + change;
    const close = price;
    const spread = trend === "volatile" ? 0.04 : 0.005;
    const high = Math.max(open, close) * (1 + Math.random() * spread);
    const low = Math.min(open, close) * (1 - Math.random() * spread);
    bars.push({
      timestamp: startTime + i * 3600_000,
      open,
      high,
      low,
      close,
      volume: 1000 + Math.random() * 5000,
    });
  }
  return bars;
}

/** Create a fake DataHub JSON response wrapping results. */
function datahubResponse(results: unknown[], status = 200) {
  return new Response(JSON.stringify({ results }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Convert OHLCV[] to the raw format DataHub returns (with date field). */
function _ohlcvToDatahubRows(bars: OHLCV[]) {
  return bars.map((b) => ({
    date: new Date(b.timestamp).toISOString().slice(0, 10),
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }));
}

/* ---------- test setup ---------- */

let tmpDir: string;

beforeAll(() => {
  tmpDir = join(tmpdir(), `l2-datahub-chain-${Date.now()}`);
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
 * 1. DataHubClient -> UnifiedProvider data transform integrity
 * ============================================================ */

describe("DataHubClient -> UnifiedProvider data transform", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("transforms raw DataHub equity rows into canonical OHLCV schema", async () => {
    const rawRows = [
      { date: "2026-01-02", open: 1800.5, high: 1820.0, low: 1795.0, close: 1810.3, vol: 45000 },
      { date: "2026-01-03", open: 1810.3, high: 1830.0, low: 1805.0, close: 1825.7, vol: 52000 },
    ];
    fetchSpy.mockResolvedValueOnce(datahubResponse(rawRows));

    const client = new DataHubClient("http://fake:8088", "admin", "key", 5000);
    const result = await client.getOHLCV({
      symbol: "600519.SH",
      market: "equity",
      timeframe: "1d",
    });

    expect(result).toHaveLength(2);
    for (const bar of result) {
      expect(bar).toHaveProperty("timestamp");
      expect(bar).toHaveProperty("open");
      expect(bar).toHaveProperty("high");
      expect(bar).toHaveProperty("low");
      expect(bar).toHaveProperty("close");
      expect(bar).toHaveProperty("volume");
      expect(typeof bar.timestamp).toBe("number");
      expect(bar.timestamp).toBeGreaterThan(0);
    }
    // Sorted ascending
    expect(result[0].timestamp).toBeLessThan(result[1].timestamp);
  });

  it("normalizes crypto rows (volume field mapping)", async () => {
    const rawRows = [
      { date: "2026-03-01", open: 62000, high: 63500, low: 61000, close: 63000, volume: 1200000 },
    ];
    fetchSpy.mockResolvedValueOnce(datahubResponse(rawRows));

    const client = new DataHubClient("http://fake:8088", "admin", "key", 5000);
    const result = await client.getOHLCV({ symbol: "BTC/USDT", market: "crypto", timeframe: "1d" });

    expect(result).toHaveLength(1);
    expect(result[0].volume).toBe(1200000);
  });

  it("handles limit parameter (returns tail of sorted data)", async () => {
    const rawRows = Array.from({ length: 20 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, "0")}`,
      open: 100 + i,
      high: 105 + i,
      low: 95 + i,
      close: 102 + i,
      volume: 10000,
    }));
    fetchSpy.mockResolvedValueOnce(datahubResponse(rawRows));

    const client = new DataHubClient("http://fake:8088", "admin", "key", 5000);
    const result = await client.getOHLCV({
      symbol: "600519.SH",
      market: "equity",
      timeframe: "1d",
      limit: 5,
    });

    expect(result).toHaveLength(5);
    // Last 5 bars (normalizeOHLCV slices from tail)
    expect(result[4].close).toBeCloseTo(121, 0);
  });

  it("throws for unsupported market type", async () => {
    const client = new DataHubClient("http://fake:8088", "admin", "key", 5000);
    await expect(
      client.getOHLCV({ symbol: "GOLD", market: "commodity", timeframe: "1d" }),
    ).rejects.toThrow(/unsupported market/i);
  });

  it("detects correct provider for different equity symbols", async () => {
    // A-share (SH) -> tushare
    const rawRows = [
      { date: "2026-01-02", open: 100, high: 105, low: 95, close: 102, volume: 1000 },
    ];
    fetchSpy.mockResolvedValueOnce(datahubResponse(rawRows));
    const client = new DataHubClient("http://fake:8088", "admin", "key", 5000);
    await client.getOHLCV({ symbol: "600519.SH", market: "equity", timeframe: "1d" });

    const url = new URL(fetchSpy.mock.calls[0]![0] as string);
    expect(url.searchParams.get("provider")).toBe("tushare");

    // US stock -> massive
    fetchSpy.mockResolvedValueOnce(datahubResponse(rawRows));
    await client.getOHLCV({ symbol: "AAPL", market: "equity", timeframe: "1d" });
    const url2 = new URL(fetchSpy.mock.calls[1]![0] as string);
    expect(url2.searchParams.get("provider")).toBe("massive");
  });
});

/* ============================================================
 * 2. Free mode fallback: DataHub unavailable -> Yahoo/CCXT
 * ============================================================ */

describe("Free mode fallback (no DataHub)", () => {
  it("routes crypto to CryptoAdapter when datahubClient is null", async () => {
    const cache = new OHLCVCache(join(tmpDir, "free-crypto.sqlite"));
    const mockBars: Array<[number, number, number, number, number, number]> = [
      [Date.now() - 7200000, 62000, 63000, 61000, 62500, 100],
      [Date.now() - 3600000, 62500, 64000, 62000, 63500, 120],
    ];
    const mockExchange = {
      fetchOHLCV: vi.fn().mockResolvedValue(mockBars),
      fetchTicker: vi.fn().mockResolvedValue({ last: 63500, timestamp: Date.now() }),
    };
    const cryptoAdapter = createCryptoAdapter(cache, async () => mockExchange);
    const detector = new RegimeDetector();

    const provider = new UnifiedDataProvider(null, cryptoAdapter, detector, cache);
    const result = await provider.getOHLCV({
      symbol: "BTC/USDT",
      market: "crypto",
      timeframe: "1h",
    });

    expect(result).toHaveLength(2);
    expect(result[0].open).toBe(62000);
    expect(mockExchange.fetchOHLCV).toHaveBeenCalled();
    cache.close();
  });

  it("routes equity to YahooAdapter when datahubClient is null", async () => {
    const cache = new OHLCVCache(join(tmpDir, "free-equity.sqlite"));
    const now = Date.now();
    const mockYahoo = {
      chart: vi.fn().mockResolvedValue({
        quotes: [
          {
            date: new Date(now - 86400000),
            open: 175,
            high: 178,
            low: 174,
            close: 177,
            volume: 50000,
          },
          { date: new Date(now), open: 177, high: 180, low: 176, close: 179, volume: 60000 },
        ],
      }),
      quote: vi.fn().mockResolvedValue({ regularMarketPrice: 179, regularMarketVolume: 60000 }),
    };
    const yahooAdapter = createYahooAdapter(cache, mockYahoo);
    const cryptoAdapter = createCryptoAdapter(cache, async () => {
      throw new Error("should not use crypto adapter");
    });
    const detector = new RegimeDetector();

    const provider = new UnifiedDataProvider(null, cryptoAdapter, detector, cache, yahooAdapter);
    const result = await provider.getOHLCV({
      symbol: "AAPL",
      market: "equity",
      timeframe: "1d",
    });

    expect(result).toHaveLength(2);
    expect(result[0].close).toBe(177);
    expect(mockYahoo.chart).toHaveBeenCalled();
    cache.close();
  });

  it("throws when equity requested but no Yahoo adapter and no DataHub", async () => {
    const cache = new OHLCVCache(join(tmpDir, "free-no-yahoo.sqlite"));
    const cryptoAdapter = createCryptoAdapter(cache, async () => {
      throw new Error("no exchange");
    });
    const detector = new RegimeDetector();

    const provider = new UnifiedDataProvider(null, cryptoAdapter, detector, cache);
    await expect(
      provider.getOHLCV({ symbol: "AAPL", market: "equity", timeframe: "1d" }),
    ).rejects.toThrow(/Equity data unavailable/);
    cache.close();
  });

  it("throws for commodity in free mode", async () => {
    const cache = new OHLCVCache(join(tmpDir, "free-commodity.sqlite"));
    const cryptoAdapter = createCryptoAdapter(cache, async () => {
      throw new Error("no exchange");
    });
    const detector = new RegimeDetector();

    const provider = new UnifiedDataProvider(null, cryptoAdapter, detector, cache);
    await expect(
      provider.getOHLCV({ symbol: "GOLD", market: "commodity", timeframe: "1d" }),
    ).rejects.toThrow(/not yet supported in free mode/);
    cache.close();
  });
});

/* ============================================================
 * 3. Multi-market OHLCV schema uniformity
 * ============================================================ */

describe("Multi-market OHLCV schema uniformity", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  const OHLCV_KEYS = ["timestamp", "open", "high", "low", "close", "volume"] as const;

  async function fetchOhlcvViaClient(symbol: string, market: string): Promise<OHLCV[]> {
    const client = new DataHubClient("http://fake:8088", "admin", "key", 5000);
    return client.getOHLCV({ symbol, market, timeframe: "1d", limit: 5 });
  }

  it("BTC/USD (crypto) returns standard OHLCV schema", async () => {
    fetchSpy.mockResolvedValueOnce(
      datahubResponse([
        { date: "2026-03-01", open: 62000, high: 63500, low: 61000, close: 63000, volume: 1200 },
      ]),
    );
    const bars = await fetchOhlcvViaClient("BTC/USDT", "crypto");
    expect(bars.length).toBeGreaterThan(0);
    for (const key of OHLCV_KEYS) {
      expect(bars[0]).toHaveProperty(key);
      expect(typeof bars[0][key]).toBe("number");
    }
  });

  it("AAPL (US equity) returns standard OHLCV schema", async () => {
    fetchSpy.mockResolvedValueOnce(
      datahubResponse([
        { date: "2026-03-01", open: 175, high: 180, low: 174, close: 179, volume: 50000 },
      ]),
    );
    const bars = await fetchOhlcvViaClient("AAPL", "equity");
    expect(bars.length).toBeGreaterThan(0);
    for (const key of OHLCV_KEYS) {
      expect(bars[0]).toHaveProperty(key);
      expect(typeof bars[0][key]).toBe("number");
    }
  });

  it("600519.SH (A-share) returns standard OHLCV schema", async () => {
    fetchSpy.mockResolvedValueOnce(
      datahubResponse([
        { trade_date: "20260301", open: 1800, high: 1820, low: 1790, close: 1810, vol: 45000 },
      ]),
    );
    const bars = await fetchOhlcvViaClient("600519.SH", "equity");
    expect(bars.length).toBeGreaterThan(0);
    for (const key of OHLCV_KEYS) {
      expect(bars[0]).toHaveProperty(key);
      expect(typeof bars[0][key]).toBe("number");
    }
  });

  it("00700.HK (HK equity) returns standard OHLCV schema", async () => {
    fetchSpy.mockResolvedValueOnce(
      datahubResponse([
        { trade_date: "20260301", open: 400, high: 410, low: 395, close: 405, vol: 30000 },
      ]),
    );
    const bars = await fetchOhlcvViaClient("00700.HK", "equity");
    expect(bars.length).toBeGreaterThan(0);
    for (const key of OHLCV_KEYS) {
      expect(bars[0]).toHaveProperty(key);
      expect(typeof bars[0][key]).toBe("number");
    }
  });
});

/* ============================================================
 * 4. Cache integration: write-through and read-back
 * ============================================================ */

describe("UnifiedProvider cache integration", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("caches OHLCV data and serves subsequent requests from cache", async () => {
    const cache = new OHLCVCache(join(tmpDir, "cache-hit.sqlite"));

    // Use daily-spaced raw rows to avoid date collisions in normalizeOHLCV
    const rawRows = Array.from({ length: 10 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, "0")}`,
      open: 1800 + i * 5,
      high: 1810 + i * 5,
      low: 1790 + i * 5,
      close: 1805 + i * 5,
      volume: 40000 + i * 1000,
    }));

    fetchSpy.mockResolvedValueOnce(datahubResponse(rawRows));

    const client = new DataHubClient("http://fake:8088", "admin", "key", 5000);
    const cryptoAdapter = createCryptoAdapter(cache, async () => {
      throw new Error("unused");
    });
    const detector = new RegimeDetector();
    const provider = new UnifiedDataProvider(client, cryptoAdapter, detector, cache);

    // First request: fetches from network
    const result1 = await provider.getOHLCV({
      symbol: "600519.SH",
      market: "equity",
      timeframe: "1d",
    });
    expect(result1).toHaveLength(10);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Second request with since/limit within cached range: should hit cache
    const since = result1[0].timestamp;
    const result2 = await provider.getOHLCV({
      symbol: "600519.SH",
      market: "equity",
      timeframe: "1d",
      since,
      limit: 5,
    });
    expect(result2).toHaveLength(5);
    // No additional fetch since cache has enough data
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    cache.close();
  });

  it("cache isolates different symbols", async () => {
    const cache = new OHLCVCache(join(tmpDir, "cache-isolation.sqlite"));
    const btcBars = generateOHLCV(5, "up", 60000);
    const ethBars = generateOHLCV(5, "down", 3000);

    cache.upsertBatch("BTC/USDT", "crypto", "1h", btcBars);
    cache.upsertBatch("ETH/USDT", "crypto", "1h", ethBars);

    const btc = cache.query("BTC/USDT", "crypto", "1h");
    const eth = cache.query("ETH/USDT", "crypto", "1h");

    expect(btc).toHaveLength(5);
    expect(eth).toHaveLength(5);
    // Verify price ranges don't leak
    expect(btc[0].open).toBeGreaterThan(50000);
    expect(eth[0].open).toBeLessThan(5000);

    cache.close();
  });
});

/* ============================================================
 * 5. Concurrent request dedup
 * ============================================================ */

describe("Concurrent request handling", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("parallel requests for same symbol both complete correctly", async () => {
    const rawRows = [
      { date: "2026-03-01", open: 1800, high: 1820, low: 1790, close: 1810, volume: 45000 },
    ];
    // Each call gets its own response (UnifiedDataProvider doesn't dedup at DataHubClient level)
    fetchSpy
      .mockResolvedValueOnce(datahubResponse(rawRows))
      .mockResolvedValueOnce(datahubResponse(rawRows));

    const cache = new OHLCVCache(join(tmpDir, "concurrent.sqlite"));
    const client = new DataHubClient("http://fake:8088", "admin", "key", 5000);
    const cryptoAdapter = createCryptoAdapter(cache, async () => {
      throw new Error("unused");
    });
    const detector = new RegimeDetector();
    const provider = new UnifiedDataProvider(client, cryptoAdapter, detector, cache);

    const [r1, r2] = await Promise.all([
      provider.getOHLCV({ symbol: "600519.SH", market: "equity", timeframe: "1d" }),
      provider.getOHLCV({ symbol: "600519.SH", market: "equity", timeframe: "1d" }),
    ]);

    // Both return valid data
    expect(r1.length).toBeGreaterThan(0);
    expect(r2.length).toBeGreaterThan(0);
    // Results are consistent (same bar data)
    expect(r1[0].close).toBe(r2[0].close);

    cache.close();
  });

  it("parallel requests for different symbols do not interfere", async () => {
    const aShareRows = [
      { date: "2026-03-01", open: 1800, high: 1820, low: 1790, close: 1810, volume: 45000 },
    ];
    const usRows = [
      { date: "2026-03-01", open: 175, high: 180, low: 174, close: 179, volume: 60000 },
    ];

    fetchSpy
      .mockResolvedValueOnce(datahubResponse(aShareRows))
      .mockResolvedValueOnce(datahubResponse(usRows));

    const cache = new OHLCVCache(join(tmpDir, "concurrent-diff.sqlite"));
    const client = new DataHubClient("http://fake:8088", "admin", "key", 5000);
    const cryptoAdapter = createCryptoAdapter(cache, async () => {
      throw new Error("unused");
    });
    const detector = new RegimeDetector();
    const provider = new UnifiedDataProvider(client, cryptoAdapter, detector, cache);

    const [aShare, us] = await Promise.all([
      provider.getOHLCV({ symbol: "600519.SH", market: "equity", timeframe: "1d" }),
      provider.getOHLCV({ symbol: "AAPL", market: "equity", timeframe: "1d" }),
    ]);

    // Different prices
    expect(aShare[0].close).toBeGreaterThan(1000);
    expect(us[0].close).toBeLessThan(500);

    cache.close();
  });
});

/* ============================================================
 * 6. Full pipeline: DataHub -> Cache -> RegimeDetector
 * ============================================================ */

describe("Full pipeline integration", () => {
  it("detectRegime flows through getOHLCV -> cache -> detector", async () => {
    const cache = new OHLCVCache(join(tmpDir, "pipeline-regime.sqlite"));
    const bars = generateOHLCV(300, "up", 100);

    // Pre-populate cache so no network call needed
    cache.upsertBatch("BTC/USDT", "crypto", "4h", bars);

    // CryptoAdapter with cache pre-populated: getRange exists, so adapter will
    // try to fetch newer data after range.latest. Return empty to indicate no new data.
    const mockExchange = {
      fetchOHLCV: vi.fn().mockResolvedValue([]),
      fetchTicker: vi.fn(),
    };
    const cryptoAdapter = createCryptoAdapter(cache, async () => mockExchange);
    const detector = new RegimeDetector();

    const provider = new UnifiedDataProvider(null, cryptoAdapter, detector, cache);

    const regime = await provider.detectRegime({
      symbol: "BTC/USDT",
      market: "crypto",
      timeframe: "4h",
    });

    expect(["bull", "bear", "sideways", "volatile", "crisis"]).toContain(regime);
    cache.close();
  });

  it("error in DataHub propagates through UnifiedProvider", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "Invalid API key" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const cache = new OHLCVCache(join(tmpDir, "pipeline-error.sqlite"));
    const client = new DataHubClient("http://fake:8088", "admin", "bad-key", 5000);
    const cryptoAdapter = createCryptoAdapter(cache, async () => {
      throw new Error("unused");
    });
    const detector = new RegimeDetector();
    const provider = new UnifiedDataProvider(client, cryptoAdapter, detector, cache);

    await expect(
      provider.getOHLCV({ symbol: "600519.SH", market: "equity", timeframe: "1d" }),
    ).rejects.toThrow(/DataHub error|Invalid API/i);

    fetchSpy.mockRestore();
    cache.close();
  });
});
