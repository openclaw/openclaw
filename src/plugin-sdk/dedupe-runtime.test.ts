import { afterEach, describe, expect, it, vi } from "vitest";
import { createPersistentDedupeCache } from "./dedupe-runtime.js";

type Record = { at: number };

function createMemoryStore() {
  const entries = new Map<string, Record>();
  return {
    entries,
    store: {
      register: vi.fn(async (key: string, value: Record) => {
        entries.set(key, value);
      }),
      lookup: vi.fn(async (key: string) => entries.get(key)),
    },
  };
}

function createCache(params?: {
  openStore?: () => ReturnType<typeof createMemoryStore>["store"] | undefined;
  logError?: (error: unknown) => void;
  readTimestamp?: (record: Record) => number | undefined;
  ttlMs?: number;
  maxSize?: number;
  persistentMaxEntries?: number;
}) {
  const backing = createMemoryStore();
  const cache = createPersistentDedupeCache<Record>({
    // Plain Symbol() is unique per cache, so parallel tests never share memory layers.
    globalKey: Symbol("test.persistent-dedupe"),
    ttlMs: params?.ttlMs ?? 60_000,
    maxSize: params?.maxSize ?? 100,
    persistent: {
      namespace: "test.persistent-dedupe",
      maxEntries: params?.persistentMaxEntries ?? 100,
      openStore: params?.openStore ?? (() => backing.store),
      logError: params?.logError,
      readTimestamp: params?.readTimestamp,
    },
  });
  return { cache, backing };
}

describe("createPersistentDedupeCache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-primes memory with the persisted timestamp when provided", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { cache, backing } = createCache({ readTimestamp: (record) => record.at });
    backing.entries.set("k3", { at: 1_000_000 - 59_000 });
    expect(await cache.lookup("k3")).toBe(true);
    // Restoring the record retains its original expiry instead of starting a fresh TTL.
    vi.setSystemTime(1_000_000 + 2_000);
    expect(cache.peek("k3")).toBe(false);
    expect(await cache.lookup("k3")).toBe(false);
  });

  it("keeps legacy persistent expirations authoritative in non-expiring memory", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const backing = createMemoryStore();
    const record = { at: Date.now() };
    const expiresAt = Date.now() + 60_000;
    backing.entries.set("legacy", record);
    const store = {
      ...backing.store,
      lookup: vi.fn(async (key: string) =>
        Date.now() < expiresAt ? backing.entries.get(key) : undefined,
      ),
      entries: vi.fn(async () => [
        { key: "legacy", value: record, createdAt: record.at, expiresAt },
      ]),
    };
    const { cache } = createCache({ ttlMs: 0, openStore: () => store });

    expect(await cache.lookup("legacy")).toBe(true);
    expect(cache.peek("legacy")).toBe(false);

    vi.setSystemTime(expiresAt);
    expect(await cache.lookup("legacy")).toBe(false);
    expect(cache.peek("legacy")).toBe(false);
    expect(store.lookup).toHaveBeenCalledTimes(2);
  });

  it("re-primes non-expiring memory only for durable persistent entries", async () => {
    const backing = createMemoryStore();
    const record = { at: 1_000_000 };
    backing.entries.set("durable", record);
    const store = {
      ...backing.store,
      entries: vi.fn(async () => [{ key: "durable", value: record, createdAt: record.at }]),
    };
    const { cache } = createCache({ ttlMs: 0, openStore: () => store });

    expect(await cache.lookup("durable")).toBe(true);
    expect(cache.peek("durable")).toBe(true);
    expect(await cache.lookup("durable")).toBe(true);
    expect(store.lookup).toHaveBeenCalledOnce();
  });

  it("rejects a persistent hit that disappears before its expiration metadata is read", async () => {
    const backing = createMemoryStore();
    backing.entries.set("missing", { at: 1_000_000 });
    const store = {
      ...backing.store,
      entries: vi.fn(async () => []),
    };
    const { cache } = createCache({ ttlMs: 0, openStore: () => store });

    expect(await cache.lookup("missing")).toBe(false);
    expect(cache.peek("missing")).toBe(false);
  });

  it("disables persistence after an expiration metadata read fails", async () => {
    const logError = vi.fn();
    const backing = createMemoryStore();
    backing.entries.set("legacy", { at: 1_000_000 });
    const error = new Error("metadata read failed");
    const store = {
      ...backing.store,
      entries: vi.fn(async () => {
        throw error;
      }),
    };
    const { cache } = createCache({ ttlMs: 0, openStore: () => store, logError });

    expect(await cache.lookup("legacy")).toBe(false);
    expect(cache.peek("legacy")).toBe(false);
    expect(logError).toHaveBeenCalledExactlyOnceWith(error);
    await cache.register("later", { at: 1_000_001 });
    expect(store.register).not.toHaveBeenCalled();
    expect(store.entries).toHaveBeenCalledOnce();
  });

  it("retains non-expiring entries past 24 hours and restores them after restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { cache, backing } = createCache({ ttlMs: 0, readTimestamp: (record) => record.at });

    await cache.register("durable", { at: Date.now() }, { at: Date.now() });
    vi.setSystemTime(1_000_000 + 25 * 60 * 60 * 1000);
    expect(cache.peek("durable")).toBe(true);

    const { cache: restarted } = createCache({
      ttlMs: 0,
      openStore: () => backing.store,
      readTimestamp: (record) => record.at,
    });
    expect(restarted.peek("durable")).toBe(false);
    expect(await restarted.lookup("durable")).toBe(true);
    expect(restarted.peek("durable")).toBe(true);

    restarted.clearForTest();
    expect(restarted.peek("durable")).toBe(false);
    expect(await restarted.lookup("durable")).toBe(true);
    expect(backing.store.lookup).toHaveBeenCalledTimes(2);
  });

  it("disables persistence after an open failure and never rejects", async () => {
    const logError = vi.fn();
    const openStore = vi.fn(() => {
      throw new Error("sqlite unavailable");
    });
    const { cache } = createCache({ openStore, logError });
    await expect(cache.register("k4", { at: 1 })).resolves.toBeUndefined();
    expect(cache.peek("k4")).toBe(true);
    expect(await cache.lookup("k5")).toBe(false);
    expect(openStore).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledTimes(1);
  });
});
