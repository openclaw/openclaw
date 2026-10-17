/**
 * Tests memory host event log helpers and persisted event behavior.
 */
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
    const workspaceDir = await createTempDir("memory-host-events-filtered-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: workspaceDir };
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
      {
        type: "memory.recall.recorded",
        timestamp: "2026-10-15T04:16:00.000Z",
        query: "newer unrelated event",
        resultCount: 0,
        results: [],
      },
      { env },
    );

    expect(
      await readMemoryHostEventRecords({
        workspaceDir,
        env,
        type: "memory.dream.completed",
        limit: 1,
      }),
    ).toEqual([phase]);
  });

  it("uses the retained tail when a cursor retires during a delayed append", async () => {
    const workspaceDir = await createTempDir("memory-host-events-retired-cursor-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: workspaceDir };
    const append = (query: string) =>
      appendMemoryHostEvent(
        workspaceDir,
        {
          type: "memory.recall.recorded",
          timestamp: "2026-09-10T12:00:00.000Z",
          query,
          resultCount: 0,
          results: [],
        },
        { env },
      );
    for (let index = 1; index <= 9; index++) {
      await append(`event-${index}`);
    }
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
    expect(
      (await listStoredMemoryHostEvents({ workspaceDir, env })).map(
        (entry) => entry.value.sequence,
      ),
    ).toEqual(Array.from({ length: 11 }, (_, index) => index + 1));
  });

  it("waits for the journal commit before completing an append", async () => {
    const workspaceDir = await createTempDir("memory-host-events-delayed-commit-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: workspaceDir };
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
    const completed = vi.fn();
    const pending = appendMemoryHostEvent(
      workspaceDir,
      {
        type: "memory.recall.recorded",
        timestamp: "2026-09-10T12:00:00.000Z",
        query: "delayed commit",
        resultCount: 0,
        results: [],
      },
      { env },
    ).then(completed);
    try {
      await entered.promise;
      expect(completed).not.toHaveBeenCalled();
      expect(await readMemoryHostEventRecords({ workspaceDir, env })).toEqual([]);
    } finally {
      release.resolve();
      await pending;
    }
    expect(await readMemoryHostEventRecords({ workspaceDir, env })).toMatchObject([
      { query: "delayed commit" },
    ]);
  });

  it("awaits event reads and propagates read rejection through the public helpers", async () => {
    const workspaceDir = await createTempDir("memory-host-events-delayed-read-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: workspaceDir };
    await appendMemoryHostEvent(
      workspaceDir,
      {
        type: "memory.recall.recorded",
        timestamp: "2026-09-10T12:00:00.000Z",
        query: "delayed read",
        resultCount: 0,
        results: [],
      },
      { env },
    );
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
    const pending = readMemoryHostEventRecords({ workspaceDir, env }).then(completed);
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
    await expect(readMemoryHostEvents({ workspaceDir, env })).rejects.toBe(failure);
  });

  it("allocates unique sequences for concurrent appends and continues after reopen", async () => {
    const workspaceDir = await createTempDir("memory-host-events-concurrent-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: workspaceDir };
    const append = (index: number) =>
      appendMemoryHostEvent(
        workspaceDir,
        {
          type: "memory.recall.recorded",
          timestamp: "2026-09-10T12:00:00.000Z",
          query: `event-${index}`,
          resultCount: 0,
          results: [],
        },
        { env },
      );
    await Promise.all(Array.from({ length: 24 }, (_, index) => append(index + 1)));
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    const stored = await listStoredMemoryHostEvents({ workspaceDir, env });
    expect(stored.map((entry) => entry.value.sequence)).toEqual(
      Array.from({ length: 24 }, (_, index) => index + 1),
    );
    expect(new Set(stored.map((entry) => entry.key)).size).toBe(24);
    await append(25);
    expect(
      (await listStoredMemoryHostEvents({ workspaceDir, env, limit: 1 }))[0]?.value.sequence,
    ).toBe(25);
  });

  it("rolls back cursor allocation and retention when journal insertion fails", async () => {
    const workspaceDir = await createTempDir("memory-host-events-rollback-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: workspaceDir };
    setMaxMemoryHostEventsForTests(1);
    const append = (query: string) =>
      appendMemoryHostEvent(
        workspaceDir,
        {
          type: "memory.recall.recorded",
          timestamp: "2026-09-10T12:00:00.000Z",
          query,
          resultCount: 0,
          results: [],
        },
        { env },
      );
    await append("retained");
    const before = await listStoredMemoryHostEvents({ workspaceDir, env });
    const { db } = openOpenClawStateDatabase({ env });
    db.exec(`CREATE TRIGGER fail_memory_journal BEFORE INSERT ON plugin_state_entries
      WHEN NEW.namespace = 'memory-host.events'
      BEGIN SELECT RAISE(ABORT, 'injected journal write failure'); END`);
    try {
      await expect(append("refused")).rejects.toMatchObject({ code: "PLUGIN_STATE_WRITE_FAILED" });
      expect(await listStoredMemoryHostEvents({ workspaceDir, env })).toEqual(before);
    } finally {
      db.exec("DROP TRIGGER fail_memory_journal");
    }
    await append("accepted");
    expect(await listStoredMemoryHostEvents({ workspaceDir, env })).toMatchObject([
      { value: { sequence: 2, event: { query: "accepted" } } },
    ]);
  });

  it("keeps legacy event readers stable when diagnostic records are present", async () => {
    const workspaceDir = await createTempDir("memory-host-events-diagnostics-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: workspaceDir };

    await appendMemoryHostEvent(
      workspaceDir,
      {
        type: "memory.recall.skipped",
        timestamp: "2026-04-05T12:00:00.000Z",
        query: "durable memory",
        reason: "non-short-term-memory-path",
        eligibleResultCount: 0,
        skippedResultCount: 1,
        results: [
          {
            path: "MEMORY.md",
            startLine: 3,
            endLine: 3,
            score: 0.9,
            reason: "non-short-term-memory-path",
          },
        ],
      },
      { env },
    );

    await appendMemoryHostEvent(
      workspaceDir,
      {
        type: "memory.recall.recorded",
        timestamp: "2026-04-05T12:05:00.000Z",
        query: "daily memory",
        resultCount: 1,
        results: [
          {
            path: "memory/2026-04-05.md",
            startLine: 1,
            endLine: 3,
            score: 0.95,
          },
        ],
      },
      { env },
    );
    await appendMemoryHostEvent(
      workspaceDir,
      {
        type: "memory.recall.skipped",
        timestamp: "2026-04-05T12:10:00.000Z",
        query: "durable memory again",
        reason: "non-short-term-memory-path",
        eligibleResultCount: 1,
        skippedResultCount: 1,
        results: [
          {
            path: "MEMORY.md",
            startLine: 4,
            endLine: 4,
            score: 0.8,
            reason: "non-short-term-memory-path",
          },
        ],
      },
      { env },
    );

    const legacyEvents = await readMemoryHostEvents({ workspaceDir, env });
    const legacyTail = await readMemoryHostEvents({ workspaceDir, limit: 1, env });
    const records = await readMemoryHostEventRecords({ workspaceDir, env });

    expect(legacyEvents.map((event) => event.type)).toEqual(["memory.recall.recorded"]);
    expect(legacyTail.map((event) => event.type)).toEqual(["memory.recall.recorded"]);
    expect(records.map((event) => event.type)).toEqual([
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
    expect(raceFirst).toBe(true);
    expect(raceSecond).toBe(false);
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
    const dedupe = createClaimableDedupe({
      ttlMs: 10_000,
      memoryMaxSize: 100,
    });

    const claims = await Promise.all([dedupe.claim("line:race-1"), dedupe.claim("line:race-1")]);
    const countClaimKind = (kind: (typeof claims)[number]["kind"]) =>
      claims.reduce((count, claim) => count + (claim.kind === kind ? 1 : 0), 0);
    expect(countClaimKind("claimed")).toBe(1);
    expect(countClaimKind("inflight")).toBe(1);

    const waitingClaim = claims.find((claim) => claim.kind === "inflight");
    await expect(dedupe.commit("line:race-1")).resolves.toBe(true);
    if (waitingClaim?.kind === "inflight") {
      await expect(waitingClaim.pending).resolves.toBe(true);
    }
    await expect(dedupe.claim("line:race-1")).resolves.toEqual({ kind: "duplicate" });
  });

  it("bounds non-finite claimable dedupe options", async () => {
    const dedupe = createClaimableDedupe({
      ttlMs: Number.NaN,
      memoryMaxSize: Number.NaN,
    });

    await expect(dedupe.claim("m1", { now: 100 })).resolves.toEqual({ kind: "claimed" });
    await expect(dedupe.commit("m1", { now: 100 })).resolves.toBe(true);
    await expect(dedupe.claim("m1", { now: 100 })).resolves.toEqual({ kind: "claimed" });
    expect(dedupe.memorySize()).toBe(0);
  });
});
