import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as eventStore from "../memory-host-sdk/event-store.js";
import {
  listStoredMemoryHostEvents,
  setMaxMemoryHostEventsForTests,
} from "../memory-host-sdk/event-store.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import * as pluginStateStore from "../plugin-state/plugin-state-store.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  appendMemoryHostEvent,
  readMemoryHostEventRecords,
  readMemoryHostEvents,
} from "./memory-host-events.js";
import { createClaimableDedupe, createPersistentDedupe } from "./persistent-dedupe.js";
import { createPluginSdkTestHarness } from "./test-helpers.js";

const { createTempDir } = createPluginSdkTestHarness();

type EventReadOptions = Omit<
  Parameters<typeof readMemoryHostEventRecords>[0],
  "workspaceDir" | "env"
>;

async function eventFixture() {
  const workspaceDir = await createTempDir("memory-host-events-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: workspaceDir };
  const append = (query: string) => appendMemoryHostEvent(workspaceDir, recall(query), { env });
  const records = (options: EventReadOptions = {}) =>
    readMemoryHostEventRecords({ workspaceDir, env, ...options });
  const stored = (options: EventReadOptions = {}) =>
    listStoredMemoryHostEvents({ workspaceDir, env, ...options });
  const legacy = (options: Pick<EventReadOptions, "limit"> = {}) =>
    readMemoryHostEvents({ workspaceDir, env, ...options });
  return { workspaceDir, env, append, records, stored, legacy };
}

function recall(query: string) {
  return {
    type: "memory.recall.recorded" as const,
    timestamp: "2026-09-10T12:00:00.000Z",
    query,
    resultCount: 0,
    results: [],
  };
}

function delayJournalCommit() {
  const entered = createDeferred();
  const release = createDeferred();
  const register = pluginStateStore.registerPluginStateSequencedJournalEntry;
  vi.spyOn(pluginStateStore, "registerPluginStateSequencedJournalEntry").mockImplementationOnce(
    async (params) => {
      entered.resolve();
      await release.promise;
      return await register(params);
    },
  );
  return { entered, release };
}

function createDedupe(root: string, overrides?: { ttlMs?: number }) {
  return createPersistentDedupe({
    ttlMs: overrides?.ttlMs ?? 24 * 60 * 60 * 1000,
    memoryMaxSize: 100,
    pluginId: "test-persistent-dedupe",
    namespacePrefix: "test-dedupe",
    stateMaxEntries: 1000,
    env: { ...process.env, OPENCLAW_STATE_DIR: root },
  });
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setMaxMemoryHostEventsForTests(undefined);
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
});

describe("memory host event journal helpers", () => {
  it("limits matching event types before returning journal history", async () => {
    const { workspaceDir, env, records } = await eventFixture();
    const phase = {
      type: "memory.dream.completed" as const,
      timestamp: "2026-10-15T04:15:00.000Z",
      phase: "deep" as const,
      outcome: "completed" as const,
      lineCount: 1,
      storageMode: "separate" as const,
    };
    await appendMemoryHostEvent(workspaceDir, { ...phase, phase: "light" }, { env });
    await appendMemoryHostEvent(workspaceDir, phase, { env });
    await appendMemoryHostEvent(
      workspaceDir,
      { ...recall("newer unrelated event"), timestamp: "2026-10-15T04:16:00.000Z" },
      { env },
    );

    expect(await records({ type: "memory.dream.completed", limit: 1 })).toEqual([phase]);
  });

  it("uses the retained tail when a cursor retires during a delayed append", async () => {
    const { env, append, stored } = await eventFixture();
    for (let index = 1; index <= 9; index++) {
      await append(`event-${index}`);
    }
    const { entered, release } = delayJournalCommit();
    const pending = append("delayed").catch((error: unknown) => error);
    try {
      await entered.promise;
      await append("intervening");
      const cursors = pluginStateStore.createPluginStateKeyedStore("memory-core", {
        namespace: "memory-host.event-cursors",
        maxEntries: 1_000,
        env,
      });
      expect(await cursors.entries()).toMatchObject([{ value: { lastSequence: 10 } }]);
      await cursors.clear();
    } finally {
      release.resolve();
      await pending;
    }
    expect(await pending).toBeUndefined();
    expect((await stored()).map((entry) => entry.value.sequence)).toEqual(
      Array.from({ length: 11 }, (_, index) => index + 1),
    );
  });

  it("waits for the journal commit before completing an append", async () => {
    const { append, records } = await eventFixture();
    const { entered, release } = delayJournalCommit();
    const completed = vi.fn();
    const pending = append("delayed commit").then(completed);
    try {
      await entered.promise;
      expect(completed).not.toHaveBeenCalled();
      expect(await records()).toEqual([]);
    } finally {
      release.resolve();
      await pending;
    }
    expect(await records()).toMatchObject([{ query: "delayed commit" }]);
  });

  it("awaits event reads and propagates read rejection through the public helpers", async () => {
    const { append, records, legacy } = await eventFixture();
    await append("delayed read");
    const entered = createDeferred();
    const release = createDeferred();
    const list = eventStore.listStoredMemoryHostEvents;
    const reader = vi
      .spyOn(eventStore, "listStoredMemoryHostEvents")
      .mockImplementationOnce(async (params) => {
        entered.resolve();
        await release.promise;
        return await list(params);
      });
    const completed = vi.fn();
    const pending = records().then(completed);
    try {
      await entered.promise;
      expect(completed).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await pending;
    }
    expect(completed).toHaveBeenCalledWith([expect.objectContaining({ query: "delayed read" })]);
    const failure = new Error("journal read failed");
    reader.mockRejectedValueOnce(failure);
    await expect(legacy()).rejects.toBe(failure);
  });

  it("allocates unique sequences for concurrent appends and continues after reopen", async () => {
    const { append, stored } = await eventFixture();
    await Promise.all(Array.from({ length: 24 }, (_, index) => append(`event-${index + 1}`)));
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    const entries = await stored();
    expect(entries.map((entry) => entry.value.sequence)).toEqual(
      Array.from({ length: 24 }, (_, index) => index + 1),
    );
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(24);
    await append("event-25");
    expect((await stored({ limit: 1 }))[0]?.value.sequence).toBe(25);
  });

  it("rolls back cursor allocation and retention when journal insertion fails", async () => {
    const { env, append, stored } = await eventFixture();
    setMaxMemoryHostEventsForTests(1);
    await append("retained");
    const before = await stored();
    const { db } = openOpenClawStateDatabase({ env });
    db.exec(`CREATE TRIGGER fail_memory_journal BEFORE INSERT ON plugin_state_entries
      WHEN NEW.namespace = 'memory-host.events'
      BEGIN SELECT RAISE(ABORT, 'injected journal write failure'); END`);
    try {
      await expect(append("refused")).rejects.toMatchObject({ code: "PLUGIN_STATE_WRITE_FAILED" });
      expect(await stored()).toEqual(before);
    } finally {
      db.exec("DROP TRIGGER fail_memory_journal");
    }
    await append("accepted");
    expect(await stored()).toMatchObject([
      { value: { sequence: 2, event: { query: "accepted" } } },
    ]);
  });

  it("keeps legacy event readers stable when diagnostic records are present", async () => {
    const { workspaceDir, env, append, records, legacy } = await eventFixture();

    const skipped = {
      type: "memory.recall.skipped" as const,
      timestamp: "2026-04-05T12:00:00.000Z",
      query: "durable memory",
      reason: "non-short-term-memory-path" as const,
      eligibleResultCount: 0,
      skippedResultCount: 0,
      results: [],
    };
    await appendMemoryHostEvent(workspaceDir, skipped, { env });
    await append("daily memory");
    await appendMemoryHostEvent(
      workspaceDir,
      {
        ...skipped,
        timestamp: "2026-10-05T12:10:00.000Z",
        query: "durable memory again",
      },
      { env },
    );

    const legacyEvents = await legacy();
    const legacyTail = await legacy({ limit: 1 });
    const events = await records();

    expect(legacyEvents.map((event) => event.type)).toEqual(["memory.recall.recorded"]);
    expect(legacyTail.map((event) => event.type)).toEqual(["memory.recall.recorded"]);
    expect(events.map((event) => event.type)).toEqual([
      "memory.recall.skipped",
      "memory.recall.recorded",
      "memory.recall.skipped",
    ]);
  });
});

describe("createPersistentDedupe", () => {
  it("deduplicates keys, persists across instances, warms up, and checks recent keys", async () => {
    const root = await createTempDir("openclaw-dedupe-");
    const first = createDedupe(root);
    expect(await first.checkAndRecord("m1", { namespace: "a" })).toBe(true);
    expect(await first.checkAndRecord("m1", { namespace: "a" })).toBe(false);

    const second = createDedupe(root);
    expect(await second.hasRecent("m1", { namespace: "a" })).toBe(true);
    expect(await second.warmup("a")).toBe(1);
    expect(await second.checkAndRecord("m1", { namespace: "a" })).toBe(false);
    expect(await second.checkAndRecord("m2", { namespace: "a" })).toBe(true);

    const raceDedupe = createDedupe(root, { ttlMs: 10_000 });
    const [raceFirst, raceSecond] = await Promise.all([
      raceDedupe.checkAndRecord("race-key", { namespace: "feishu" }),
      raceDedupe.checkAndRecord("race-key", { namespace: "feishu" }),
    ]);
    expect([raceFirst, raceSecond]).toEqual([true, false]);
  });

  it("bounds non-finite persistent dedupe options", async () => {
    const root = await createTempDir("openclaw-dedupe-");
    const dedupe = createPersistentDedupe({
      ttlMs: Number.NaN,
      memoryMaxSize: Number.NaN,
      pluginId: "test-persistent-dedupe",
      namespacePrefix: "test-bounds",
      stateMaxEntries: Number.NaN,
      env: { ...process.env, OPENCLAW_STATE_DIR: root },
    });

    expect(await dedupe.checkAndRecord("m1", { namespace: "a", now: 100 })).toBe(true);
    expect(await dedupe.hasRecent("m1", { namespace: "a", now: 100 })).toBe(true);
    expect(await dedupe.checkAndRecord("m1", { namespace: "a", now: 100 })).toBe(false);
    expect(dedupe.memorySize()).toBe(0);
  });

  it("uses legacy JSON paths only as SQLite namespace identifiers", async () => {
    const root = await createTempDir("openclaw-legacy-dedupe-");
    const legacyPath = path.join(root, "legacy.json");
    const dedupe = createPersistentDedupe({
      ttlMs: 10_000,
      memoryMaxSize: 100,
      fileMaxEntries: 1000,
      resolveFilePath: () => legacyPath,
      env: { ...process.env, OPENCLAW_STATE_DIR: root },
    });

    expect(await dedupe.checkAndRecord("sqlite-only", { namespace: "x" })).toBe(true);
    expect(await dedupe.checkAndRecord("sqlite-only", { namespace: "x" })).toBe(false);
    await expect(fs.access(legacyPath)).rejects.toThrow();
  });
});

describe("createClaimableDedupe", () => {
  it("serializes concurrent claims and records on commit", async () => {
    const dedupe = createClaimableDedupe({ ttlMs: 10_000, memoryMaxSize: 100 });

    const claims = await Promise.all([dedupe.claim("line:race-1"), dedupe.claim("line:race-1")]);
    expect(claims.map((claim) => claim.kind).toSorted()).toEqual(["claimed", "inflight"]);

    const waitingClaim = claims.find((claim) => claim.kind === "inflight");
    await expect(dedupe.commit("line:race-1")).resolves.toBe(true);
    if (waitingClaim?.kind === "inflight") {
      await expect(waitingClaim.pending).resolves.toBe(true);
    }
    await expect(dedupe.claim("line:race-1")).resolves.toEqual({ kind: "duplicate" });
  });

  it("bounds non-finite claimable dedupe options", async () => {
    const dedupe = createClaimableDedupe({ ttlMs: Number.NaN, memoryMaxSize: Number.NaN });

    await expect(dedupe.claim("m1", { now: 100 })).resolves.toEqual({ kind: "claimed" });
    await expect(dedupe.commit("m1", { now: 100 })).resolves.toBe(true);
    await expect(dedupe.claim("m1", { now: 100 })).resolves.toEqual({ kind: "claimed" });
    expect(dedupe.memorySize()).toBe(0);
  });
});
