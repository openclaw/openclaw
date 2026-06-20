import { describe, expect, it } from "vitest";
import {
  listSessionStoreRecordEntries,
  type SessionStoreAdapter,
  type SessionStoreListOptions,
  type SessionStoreRecord,
} from "./storage-adapter.js";
import {
  createSyntheticSessionStore,
  runBoundedSessionStoreReadBenchmark,
  SessionStoreBenchmarkError,
  syntheticSessionStoreKey,
} from "./store-benchmark.js";
import {
  createInMemorySessionStoreMetricsRecorder,
  instrumentSessionStoreAdapter,
} from "./store-observability.js";

type CountingAdapter = SessionStoreAdapter & {
  operations: string[];
};

function createCountingReadAdapter(store: SessionStoreRecord): CountingAdapter {
  const operations: string[] = [];
  return {
    kind: "memory",
    operations,
    async loadStore() {
      operations.push("loadStore");
      throw new Error("loadStore is not allowed in bounded read benchmarks");
    },
    async readEntry(_storePath: string, sessionKey: string) {
      operations.push("readEntry");
      return structuredClone(store[sessionKey]);
    },
    async listEntries(_storePath: string, options?: SessionStoreListOptions) {
      operations.push("listEntries");
      return listSessionStoreRecordEntries(store, options);
    },
    async saveStore() {
      operations.push("saveStore");
      throw new Error("saveStore is not allowed in bounded read benchmarks");
    },
    async updateStore() {
      operations.push("updateStore");
      throw new Error("updateStore is not allowed in bounded read benchmarks");
    },
  };
}

describe("session store benchmark harness", () => {
  it("walks a synthetic store through bounded pages without full-store hot-path calls", async () => {
    const store = createSyntheticSessionStore({
      sessionCount: 12,
      updatedAtStartMs: 1_000,
      updatedAtStepMs: 10,
    });
    const counting = createCountingReadAdapter(store);
    const recorder = createInMemorySessionStoreMetricsRecorder();
    const metricTimes = [200, 203, 210, 213, 220, 223, 230, 231, 240, 241, 250, 251];
    const adapter = instrumentSessionStoreAdapter(counting, {
      recorder,
      nowMs: () => metricTimes.shift() ?? 999,
    });

    await expect(
      runBoundedSessionStoreReadBenchmark(adapter, {
        storePath: "/state/type0-producer/sessions.json",
        pageSize: 5,
        expectedTotalCount: 12,
        readKeys: [syntheticSessionStoreKey(0), syntheticSessionStoreKey(11), "agent:main:missing"],
        nowMs: (() => {
          const times = [1_000, 1_012];
          return () => times.shift() ?? 1_012;
        })(),
      }),
    ).resolves.toEqual({
      storePath: "/state/type0-producer/sessions.json",
      backend: "memory",
      pageSize: 5,
      orderBy: "updatedAt_desc",
      pages: 3,
      entriesRead: 12,
      totalCount: 12,
      maxPageEntries: 5,
      readKeys: 3,
      readHits: 2,
      readMisses: 1,
      elapsedMs: 12,
    });

    expect(counting.operations).toEqual([
      "listEntries",
      "listEntries",
      "listEntries",
      "readEntry",
      "readEntry",
      "readEntry",
    ]);
    expect(recorder.metrics).toEqual([
      expect.objectContaining({
        operation: "listEntries",
        entryCount: 5,
        totalCount: 12,
        hasMore: true,
      }),
      expect.objectContaining({
        operation: "listEntries",
        entryCount: 5,
        totalCount: 12,
        hasMore: true,
      }),
      expect.objectContaining({
        operation: "listEntries",
        entryCount: 2,
        totalCount: 12,
        hasMore: false,
      }),
      expect.objectContaining({ operation: "readEntry", entryCount: 1 }),
      expect.objectContaining({ operation: "readEntry", entryCount: 1 }),
      expect.objectContaining({ operation: "readEntry", entryCount: 0 }),
    ]);
  });

  it("rejects adapters that do not advance pagination", async () => {
    const adapter: SessionStoreAdapter = {
      kind: "faulty",
      async loadStore() {
        return {};
      },
      async readEntry() {
        return undefined;
      },
      async listEntries(_storePath, options) {
        return {
          entries: [["stuck", { sessionId: "stuck", updatedAt: 1 }]],
          totalCount: 2,
          offset: options?.offset,
          nextOffset: options?.offset ?? 0,
          hasMore: true,
        };
      },
      async saveStore() {},
      async updateStore<T>() {
        return undefined as T;
      },
    };

    await expect(
      runBoundedSessionStoreReadBenchmark(adapter, {
        storePath: "/state/faulty/sessions.json",
        pageSize: 1,
      }),
    ).rejects.toBeInstanceOf(SessionStoreBenchmarkError);
  });

  it("rejects unexpected total counts before benchmark receipts can go green", async () => {
    const adapter = createCountingReadAdapter(createSyntheticSessionStore({ sessionCount: 3 }));

    await expect(
      runBoundedSessionStoreReadBenchmark(adapter, {
        storePath: "/state/type0-audit/sessions.json",
        pageSize: 2,
        expectedTotalCount: 4,
      }),
    ).rejects.toThrow("expected 4 entries");
  });
});
