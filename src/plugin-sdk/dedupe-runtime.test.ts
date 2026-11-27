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

afterEach(() => vi.useRealTimers());

it.each([
  { name: "timestamped TTL", ttl: 60_000, age: 59_000, advance: 2_000, legacy: false },
  { name: "legacy expiration", ttl: 0, age: 0, advance: 60_000, legacy: true },
  { name: "non-expiring", ttl: 0, age: 0, advance: 25 * 60 * 60 * 1000, legacy: false },
])("preserves $name across memory and persistence", async ({ ttl, age, advance, legacy }) => {
  const now = 1_000_000;
  vi.useFakeTimers({ now });
  const record = { at: now - age };
  const infinite = !ttl && !legacy;
  const backing = memoryStore(infinite ? undefined : record);
  const store = legacy
    ? {
        ...backing,
        lookup: vi.fn(async (key: string) =>
          Date.now() < now + advance ? backing.lookup(key) : undefined,
        ),
        entries: async () => [{ key: "k", expiresAt: now + advance }],
      }
    : backing;
  const { cache } = createCache(() => store, ttl, timestampOf);
  if (infinite) {
    await cache.register("k", record, { at: now });
  }
  expect([await cache.lookup("k"), cache.peek("k")]).toEqual([true, !legacy]);
  vi.setSystemTime(now + advance);
  expect([cache.peek("k"), await cache.lookup("k")]).toEqual([infinite, infinite]);
  if (infinite) {
    const { cache: restarted } = createCache(() => store, ttl, timestampOf);
    expect(restarted.peek("k")).toBe(false);
    expect([await restarted.lookup("k"), restarted.peek("k")]).toEqual([true, true]);
    restarted.clearForTest();
    expect(restarted.peek("k")).toBe(false);
    expect(await restarted.lookup("k")).toBe(true);
  }
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
    }
  },
);

it("disables persistence after an open failure and never rejects", async () => {
  const openStore = vi.fn(() => {
    throw new Error("sqlite unavailable");
  });
  const { cache, logError } = createCache(openStore, 60_000);
  await expect(cache.register("k", { at: 1 })).resolves.toBeUndefined();
  expect([cache.peek("k"), await cache.lookup("missing")]).toEqual([true, false]);
  expect(logError).toHaveBeenCalledTimes(1);
});
