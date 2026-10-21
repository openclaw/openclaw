import { afterEach, expect, it, vi } from "vitest";
import { createPersistentDedupeCache } from "./dedupe-runtime.js";

type Record = { at: number };
const timestampOf = (record: Record) => record.at;

function memoryStore(record?: Record) {
  const records = new Map<string, Record>(record ? [["k", record]] : []);
  return {
    register: vi.fn(async (key: string, value: Record) => {
      records.set(key, value);
    }),
    lookup: vi.fn(async (key: string) => records.get(key)),
  };
}

function createCache(
  openStore: () => ReturnType<typeof memoryStore>,
  ttlMs = 0,
  readTimestamp?: (record: Record) => number,
) {
  const logError = vi.fn();
  const cache = createPersistentDedupeCache<Record>({
    globalKey: Symbol("test.persistent-dedupe"),
    ttlMs,
    maxSize: 100,
    persistent: {
      namespace: "test.persistent-dedupe",
      maxEntries: 100,
      openStore,
      logError,
      readTimestamp,
    },
  });
  return { cache, logError };
}

afterEach(() => {
  vi.useRealTimers();
});

it("re-primes memory with the persisted timestamp when provided", async () => {
  vi.useFakeTimers({ now: 1_000_000 });
  const store = memoryStore({ at: 1_000_000 - 59_000 });
  const { cache } = createCache(() => store, 60_000, timestampOf);
  expect(await cache.lookup("k")).toBe(true);
  vi.setSystemTime(1_000_000 + 2_000);
  expect(cache.peek("k")).toBe(false);
  expect(await cache.lookup("k")).toBe(false);
});

it("keeps legacy persistent expirations authoritative in non-expiring memory", async () => {
  vi.useFakeTimers({ now: 1_000_000 });
  const expiresAt = Date.now() + 60_000;
  const backing = memoryStore({ at: Date.now() });
  const store = {
    ...backing,
    lookup: vi.fn(async (key: string) =>
      Date.now() < expiresAt ? backing.lookup(key) : undefined,
    ),
    entries: vi.fn(async () => [{ key: "k", expiresAt }]),
  };
  const { cache } = createCache(() => store);
  expect([await cache.lookup("k"), cache.peek("k")]).toEqual([true, false]);
  vi.setSystemTime(expiresAt);
  expect([await cache.lookup("k"), cache.peek("k")]).toEqual([false, false]);
  expect(store.lookup).toHaveBeenCalledTimes(2);
});

it.each(["present", "missing", "failed"] as const)(
  "handles non-expiring persistent metadata: %s",
  async (metadata) => {
    const error = new Error("metadata read failed");
    const store = {
      ...memoryStore({ at: 1_000_000 }),
      entries: vi.fn(async () => [{ key: "k" }]),
    };
    if (metadata === "missing") {
      store.entries.mockResolvedValue([]);
    }
    if (metadata === "failed") {
      store.entries.mockRejectedValue(error);
    }
    const { cache, logError } = createCache(() => store);
    const present = metadata === "present";
    expect([await cache.lookup("k"), cache.peek("k")]).toEqual([present, present]);
    if (present) {
      expect(await cache.lookup("k")).toBe(true);
      expect(store.lookup).toHaveBeenCalledOnce();
    }
    if (metadata === "failed") {
      expect(logError).toHaveBeenCalledExactlyOnceWith(error);
      await cache.register("later", { at: 1_000_001 });
      expect(store.register).not.toHaveBeenCalled();
      expect(store.entries).toHaveBeenCalledOnce();
    }
  },
);

it("retains non-expiring entries past 24 hours and restores them after restart", async () => {
  vi.useFakeTimers({ now: 1_000_000 });
  const store = memoryStore();
  const { cache } = createCache(() => store, 0, timestampOf);
  await cache.register("k", { at: Date.now() }, { at: Date.now() });
  vi.setSystemTime(1_000_000 + 25 * 60 * 60 * 1000);
  expect(cache.peek("k")).toBe(true);

  const { cache: restarted } = createCache(() => store, 0, timestampOf);
  expect(restarted.peek("k")).toBe(false);
  expect([await restarted.lookup("k"), restarted.peek("k")]).toEqual([true, true]);
  restarted.clearForTest();
  expect(restarted.peek("k")).toBe(false);
  expect(await restarted.lookup("k")).toBe(true);
  expect(store.lookup).toHaveBeenCalledTimes(2);
});

it("disables persistence after an open failure and never rejects", async () => {
  const openStore = vi.fn(() => {
    throw new Error("sqlite unavailable");
  });
  const { cache, logError } = createCache(openStore, 60_000);
  await expect(cache.register("k", { at: 1 })).resolves.toBeUndefined();
  expect(cache.peek("k")).toBe(true);
  expect(await cache.lookup("missing")).toBe(false);
  expect(openStore).toHaveBeenCalledTimes(1);
  expect(logError).toHaveBeenCalledTimes(1);
});
