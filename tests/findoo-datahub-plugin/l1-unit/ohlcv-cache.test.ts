/**
 * L1 单元测试: OHLCVCache
 *
 * 使用真实 SQLite (node:sqlite DatabaseSync)，临时数据库文件。
 * 验证:
 * - upsert + query 完整往返
 * - INSERT OR REPLACE 幂等性
 * - getRange 正确返回 / 空表返回 null
 * - since/until 时间窗口过滤
 * - 不同 symbol/market/timeframe 数据隔离
 * - close() 幂等
 * - 空批次 upsert 不报错
 * - 大批量数据写入/查询
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OHLCVCache } from "../../../extensions/findoo-datahub-plugin/src/ohlcv-cache.js";
import type { OHLCV } from "../../../extensions/findoo-datahub-plugin/src/types.js";

let tmpDir: string;

beforeAll(() => {
  tmpDir = join(tmpdir(), `datahub-cache-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // 清理失败不阻塞测试
  }
});

/** 生成指定数量的 OHLCV 测试数据 */
function makeOHLCV(count: number, startTs = 1700000000000, interval = 3600_000): OHLCV[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: startTs + i * interval,
    open: 100 + i,
    high: 105 + i,
    low: 95 + i,
    close: 102 + i,
    volume: 1000 + i * 100,
  }));
}

describe("OHLCVCache", () => {
  // --- 1. upsert + query 往返 ---
  it("upsertBatch + query 完整往返, 6 字段一致", () => {
    const cache = new OHLCVCache(join(tmpDir, "roundtrip.sqlite"));
    const bars = makeOHLCV(10);

    cache.upsertBatch("BTC/USDT", "crypto", "1h", bars);
    const result = cache.query("BTC/USDT", "crypto", "1h");

    expect(result).toHaveLength(10);
    expect(result[0].timestamp).toBe(bars[0].timestamp);
    expect(result[0].open).toBe(bars[0].open);
    expect(result[0].high).toBe(bars[0].high);
    expect(result[0].low).toBe(bars[0].low);
    expect(result[0].close).toBe(bars[0].close);
    expect(result[0].volume).toBe(bars[0].volume);
    cache.close();
  });

  // --- 2. INSERT OR REPLACE 幂等 ---
  it("upsertBatch 同主键覆盖旧值 (幂等)", () => {
    const cache = new OHLCVCache(join(tmpDir, "idempotent.sqlite"));
    const bars = makeOHLCV(5);

    cache.upsertBatch("ETH/USDT", "crypto", "1d", bars);
    // 修改 close 后重新 upsert
    const updated = bars.map((b) => ({ ...b, close: b.close + 999 }));
    cache.upsertBatch("ETH/USDT", "crypto", "1d", updated);

    const result = cache.query("ETH/USDT", "crypto", "1d");
    expect(result).toHaveLength(5);
    expect(result[0].close).toBe(updated[0].close);
    cache.close();
  });

  // --- 3. getRange 空表返回 null ---
  it("getRange 空表返回 null", () => {
    const cache = new OHLCVCache(join(tmpDir, "empty-range.sqlite"));
    const range = cache.getRange("NONEXIST", "crypto", "1h");
    expect(range).toBeNull();
    cache.close();
  });

  // --- 4. getRange 返回正确的 earliest/latest ---
  it("getRange 返回正确的 earliest 和 latest", () => {
    const cache = new OHLCVCache(join(tmpDir, "range.sqlite"));
    const bars = makeOHLCV(20);
    cache.upsertBatch("SOL/USDT", "crypto", "4h", bars);

    const range = cache.getRange("SOL/USDT", "crypto", "4h");
    expect(range).not.toBeNull();
    expect(range!.earliest).toBe(bars[0].timestamp);
    expect(range!.latest).toBe(bars[19].timestamp);
    cache.close();
  });

  // --- 5. since 过滤 ---
  it("query with since 只返回 >= since 的数据", () => {
    const cache = new OHLCVCache(join(tmpDir, "since.sqlite"));
    const bars = makeOHLCV(20);
    cache.upsertBatch("ADA/USDT", "crypto", "1h", bars);

    const midTs = bars[10].timestamp;
    const result = cache.query("ADA/USDT", "crypto", "1h", midTs);

    expect(result.length).toBe(10); // bars[10] ~ bars[19]
    expect(result[0].timestamp).toBe(midTs);
    cache.close();
  });

  // --- 6. until 过滤 ---
  it("query with until 只返回 <= until 的数据", () => {
    const cache = new OHLCVCache(join(tmpDir, "until.sqlite"));
    const bars = makeOHLCV(20);
    cache.upsertBatch("DOT/USDT", "crypto", "1h", bars);

    const untilTs = bars[9].timestamp;
    const result = cache.query("DOT/USDT", "crypto", "1h", undefined, untilTs);

    expect(result.length).toBe(10); // bars[0] ~ bars[9]
    expect(result[result.length - 1].timestamp).toBe(untilTs);
    cache.close();
  });

  // --- 7. since + until 组合 ---
  it("query with since + until 返回时间窗口内数据", () => {
    const cache = new OHLCVCache(join(tmpDir, "window.sqlite"));
    const bars = makeOHLCV(20);
    cache.upsertBatch("LINK/USDT", "crypto", "1h", bars);

    const since = bars[5].timestamp;
    const until = bars[14].timestamp;
    const result = cache.query("LINK/USDT", "crypto", "1h", since, until);

    expect(result.length).toBe(10); // bars[5] ~ bars[14]
    cache.close();
  });

  // --- 8. 不同 symbol 数据隔离 ---
  it("不同 symbol 的数据相互隔离", () => {
    const cache = new OHLCVCache(join(tmpDir, "isolation-sym.sqlite"));
    const btc = makeOHLCV(5, 1700000000000);
    const eth = makeOHLCV(3, 1700000000000);

    cache.upsertBatch("BTC/USDT", "crypto", "1h", btc);
    cache.upsertBatch("ETH/USDT", "crypto", "1h", eth);

    expect(cache.query("BTC/USDT", "crypto", "1h")).toHaveLength(5);
    expect(cache.query("ETH/USDT", "crypto", "1h")).toHaveLength(3);
    cache.close();
  });

  // --- 9. 不同 market 数据隔离 ---
  it("不同 market 的数据相互隔离", () => {
    const cache = new OHLCVCache(join(tmpDir, "isolation-mkt.sqlite"));
    const bars = makeOHLCV(5);

    cache.upsertBatch("AAPL", "equity", "1d", bars);
    cache.upsertBatch("AAPL", "crypto", "1d", bars.slice(0, 2));

    expect(cache.query("AAPL", "equity", "1d")).toHaveLength(5);
    expect(cache.query("AAPL", "crypto", "1d")).toHaveLength(2);
    cache.close();
  });

  // --- 10. 不同 timeframe 数据隔离 ---
  it("不同 timeframe 的数据相互隔离", () => {
    const cache = new OHLCVCache(join(tmpDir, "isolation-tf.sqlite"));
    const bars = makeOHLCV(8);

    cache.upsertBatch("BTC/USDT", "crypto", "1h", bars);
    cache.upsertBatch("BTC/USDT", "crypto", "4h", bars.slice(0, 3));

    expect(cache.query("BTC/USDT", "crypto", "1h")).toHaveLength(8);
    expect(cache.query("BTC/USDT", "crypto", "4h")).toHaveLength(3);
    cache.close();
  });

  // --- 11. close() 幂等 ---
  it("close() 可安全多次调用", () => {
    const cache = new OHLCVCache(join(tmpDir, "close-idem.sqlite"));
    cache.close();
    cache.close(); // 不应报错
    cache.close();
  });

  // --- 12. 空批次 upsert 不报错 ---
  it("upsertBatch 空数组不报错", () => {
    const cache = new OHLCVCache(join(tmpDir, "empty-upsert.sqlite"));
    expect(() => {
      cache.upsertBatch("BTC/USDT", "crypto", "1h", []);
    }).not.toThrow();
    cache.close();
  });

  // --- 13. 查询结果按 timestamp 升序排列 ---
  it("query 结果按 timestamp 升序排列", () => {
    const cache = new OHLCVCache(join(tmpDir, "order.sqlite"));
    // 故意倒序插入
    const bars = makeOHLCV(10).toReversed();
    cache.upsertBatch("BTC/USDT", "crypto", "1h", bars);

    const result = cache.query("BTC/USDT", "crypto", "1h");
    for (let i = 1; i < result.length; i++) {
      expect(result[i].timestamp).toBeGreaterThan(result[i - 1].timestamp);
    }
    cache.close();
  });

  // --- 14. 大批量写入/查询 ---
  it("支持 1000 条数据批量写入和查询", () => {
    const cache = new OHLCVCache(join(tmpDir, "bulk.sqlite"));
    const bars = makeOHLCV(1000);
    cache.upsertBatch("BTC/USDT", "crypto", "1m", bars);

    const result = cache.query("BTC/USDT", "crypto", "1m");
    expect(result).toHaveLength(1000);
    cache.close();
  });
});
