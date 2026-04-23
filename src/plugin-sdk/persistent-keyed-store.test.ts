import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drainFileLockStateForTest, resetFileLockStateForTest } from "./file-lock.js";
import { createPersistentKeyedStore } from "./persistent-keyed-store.js";
import { createPluginSdkTestHarness } from "./test-helpers.js";

type DemoRecord = {
  value: string | number;
};

const { createTempDir } = createPluginSdkTestHarness();

function createStore(
  stateDir: string,
  overrides?: {
    namespace?: string;
    maxEntries?: number;
    defaultTtlMs?: number;
    logger?: { warn: (message: string, meta?: unknown) => void };
  },
) {
  return createPersistentKeyedStore<DemoRecord>({
    namespace: overrides?.namespace ?? "demo-store",
    stateDir,
    defaultTtlMs: overrides?.defaultTtlMs,
    maxEntries: overrides?.maxEntries ?? 100,
    logger: overrides?.logger,
  });
}

function resolveStoreFile(stateDir: string, namespace = "demo-store"): string {
  return path.join(stateDir, "lifecycle", namespace, "store.json");
}

async function readStoreEnvelope(stateDir: string, namespace = "demo-store") {
  const raw = await fs.readFile(resolveStoreFile(stateDir, namespace), "utf8");
  return JSON.parse(raw) as {
    version: number;
    entries: Record<
      string,
      {
        record: DemoRecord;
        createdAt: number;
        expiresAt?: number;
      }
    >;
  };
}

describe("createPersistentKeyedStore", () => {
  beforeEach(() => {
    resetFileLockStateForTest();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await drainFileLockStateForTest();
  });

  it("registers and looks up records within one instance", async () => {
    const stateDir = await createTempDir("openclaw-keyed-store-");
    const store = createStore(stateDir);

    await store.register("message-1", { value: "hello" });

    await expect(store.lookup("message-1")).resolves.toEqual({ value: "hello" });
  });

  it("persists records across new instances", async () => {
    const stateDir = await createTempDir("openclaw-keyed-store-");
    const writer = createStore(stateDir);

    await writer.register("message-1", { value: "hello" });

    const reader = createStore(stateDir);
    await expect(reader.lookup("message-1")).resolves.toEqual({ value: "hello" });
  });

  it("expires per-call ttl entries on lookup after the clock advances", async () => {
    const stateDir = await createTempDir("openclaw-keyed-store-");
    const store = createStore(stateDir);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T12:00:00.000Z"));
    await store.register("message-1", { value: "hello" }, { ttlMs: 100 });

    vi.setSystemTime(new Date("2026-04-23T12:00:00.100Z"));
    await expect(store.lookup("message-1")).resolves.toBeUndefined();
    await expect(store.entries()).resolves.toEqual([]);
  });

  it("uses defaultTtlMs when register omits ttlMs", async () => {
    const stateDir = await createTempDir("openclaw-keyed-store-");
    const store = createStore(stateDir, { defaultTtlMs: 100 });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T12:00:00.000Z"));
    await store.register("message-1", { value: "hello" });

    vi.setSystemTime(new Date("2026-04-23T12:00:00.100Z"));
    await expect(store.lookup("message-1")).resolves.toBeUndefined();
  });

  it("consumes records atomically", async () => {
    const stateDir = await createTempDir("openclaw-keyed-store-");
    const store = createStore(stateDir);

    await store.register("message-1", { value: "hello" });

    await expect(store.consume("message-1")).resolves.toEqual({ value: "hello" });
    await expect(store.lookup("message-1")).resolves.toBeUndefined();
  });

  it("returns entries in deterministic order with metadata", async () => {
    const stateDir = await createTempDir("openclaw-keyed-store-");
    const store = createStore(stateDir);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T12:00:00.000Z"));
    const firstTimestamp = Date.now();
    await store.register("b", { value: "b" });
    await store.register("a", { value: "a" });

    vi.setSystemTime(new Date("2026-04-23T12:00:00.001Z"));
    const secondTimestamp = Date.now();
    await store.register("c", { value: "c" });

    await expect(store.entries()).resolves.toEqual([
      { id: "a", record: { value: "a" }, createdAt: firstTimestamp },
      { id: "b", record: { value: "b" }, createdAt: firstTimestamp },
      { id: "c", record: { value: "c" }, createdAt: secondTimestamp },
    ]);
  });

  it("clears the store", async () => {
    const stateDir = await createTempDir("openclaw-keyed-store-");
    const store = createStore(stateDir);

    await store.register("message-1", { value: "hello" });
    await store.clear();

    await expect(store.entries()).resolves.toEqual([]);
    await expect(readStoreEnvelope(stateDir)).resolves.toEqual({
      version: 1,
      entries: {},
    });
  });

  it("treats a missing file as empty without warning", async () => {
    const stateDir = await createTempDir("openclaw-keyed-store-");
    const warn = vi.fn();
    const store = createStore(stateDir, { logger: { warn } });

    await expect(store.lookup("missing")).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("quarantines corrupt json, warns, and starts empty", async () => {
    const stateDir = await createTempDir("openclaw-keyed-store-");
    const storeFile = resolveStoreFile(stateDir);
    const warn = vi.fn();
    await fs.mkdir(path.dirname(storeFile), { recursive: true });
    await fs.writeFile(storeFile, "{not-json", "utf8");

    const store = createStore(stateDir, { logger: { warn } });

    await expect(store.entries()).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);

    const files = await fs.readdir(path.dirname(storeFile));
    expect(files).toEqual(
      expect.arrayContaining([expect.stringMatching(/^store\.vunknown\.corrupt-\d+\.json$/)]),
    );
    expect(files).not.toContain("store.json");
  });

  it("quarantines higher-version files, warns, and starts empty", async () => {
    const stateDir = await createTempDir("openclaw-keyed-store-");
    const storeFile = resolveStoreFile(stateDir);
    const warn = vi.fn();
    await fs.mkdir(path.dirname(storeFile), { recursive: true });
    await fs.writeFile(storeFile, JSON.stringify({ version: 2, entries: {} }, null, 2), "utf8");

    const store = createStore(stateDir, { logger: { warn } });

    await expect(store.entries()).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);

    const files = await fs.readdir(path.dirname(storeFile));
    expect(files).toEqual(
      expect.arrayContaining([expect.stringMatching(/^store\.v2\.corrupt-\d+\.json$/)]),
    );
    expect(files).not.toContain("store.json");
  });

  it("rejects invalid namespaces before any file io", async () => {
    const stateDir = await createTempDir("openclaw-keyed-store-");

    expect(() =>
      createPersistentKeyedStore<DemoRecord>({
        namespace: "../escape",
        stateDir,
        maxEntries: 1,
      }),
    ).toThrow(/namespace/i);

    await expect(fs.access(path.join(stateDir, "lifecycle"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("prunes the oldest live entries when maxEntries is exceeded", async () => {
    const stateDir = await createTempDir("openclaw-keyed-store-");
    const store = createStore(stateDir, { maxEntries: 2 });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T12:00:00.000Z"));
    await store.register("a", { value: "a" });

    vi.setSystemTime(new Date("2026-04-23T12:00:00.001Z"));
    await store.register("b", { value: "b" });

    vi.setSystemTime(new Date("2026-04-23T12:00:00.002Z"));
    await store.register("c", { value: "c" });

    await expect(store.entries()).resolves.toEqual([
      { id: "b", record: { value: "b" }, createdAt: Date.parse("2026-04-23T12:00:00.001Z") },
      { id: "c", record: { value: "c" }, createdAt: Date.parse("2026-04-23T12:00:00.002Z") },
    ]);
  });

  it("serializes concurrent registers across two instances", async () => {
    const stateDir = await createTempDir("openclaw-keyed-store-");
    const first = createStore(stateDir);
    const second = createStore(stateDir);

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 === 0 ? first : second).register(`message-${index}`, { value: index }),
      ),
    );

    const entries = await first.entries();
    expect(entries).toHaveLength(20);
    expect(entries.map((entry) => entry.id).toSorted()).toEqual(
      Array.from({ length: 20 }, (_, index) => `message-${index}`).toSorted(),
    );
  });

  it("keeps only the latest record when overwriting an existing id", async () => {
    const stateDir = await createTempDir("openclaw-keyed-store-");
    const store = createStore(stateDir);

    await store.register("message-1", { value: "first" });
    await store.register("message-1", { value: "second" });

    await expect(store.lookup("message-1")).resolves.toEqual({ value: "second" });
    await expect(store.entries()).resolves.toEqual([
      expect.objectContaining({ id: "message-1", record: { value: "second" } }),
    ]);
  });
});
