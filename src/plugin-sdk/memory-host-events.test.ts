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
  normalizeMemoryHostEventRecordForStorage,
  setMaxMemoryHostEventsForTests,
} from "../memory-host-sdk/event-store.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import * as pluginStateStore from "../plugin-state/plugin-state-store.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  appendMemoryHostEvent,
  readMemoryHostEventRecords,
  readMemoryHostEvents,
} from "./memory-host-events.js";
import {
  createClaimableDedupe,
  createPersistentDedupe,
  listPersistentDedupeLegacyJsonFileEntries,
} from "./persistent-dedupe.js";
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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setMaxMemoryHostEventsForTests(undefined);
  resetPluginStateStoreForTests();
});

describe("memory host event journal helpers", () => {
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

  it.each([
    { name: "fractional sequence", value: { kind: "event", sequence: 1.5 }, next: undefined },
    {
      name: "unsafe sequence",
      value: { kind: "event", sequence: Number.MAX_SAFE_INTEGER + 1 },
      next: undefined,
    },
    { name: "null record", value: null, next: undefined },
    { name: "other record kind", value: { kind: "other", sequence: "invalid" }, next: 2 },
    { name: "numeric string", value: { kind: "event", sequence: "2" }, next: 3 },
  ])("preserves retained-tail decoding for $name", async ({ value, next }) => {
    const workspaceDir = await createTempDir("memory-host-events-tail-decoding-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: workspaceDir };
    const append = () =>
      appendMemoryHostEvent(
        workspaceDir,
        {
          type: "memory.recall.recorded",
          timestamp: "2026-09-10T12:00:00.000Z",
          query: "valid event",
          resultCount: 0,
          results: [],
        },
        { env },
      );
    await append();
    const entry = (await listStoredMemoryHostEvents({ workspaceDir, env }))[0];
    if (!entry) {
      throw new Error("expected initial journal entry");
    }
    const journal = pluginStateStore.createPluginStateKeyedStore("memory-core", {
      namespace: "memory-host.events",
      maxEntries: 10_000,
      env,
    });
    const cursors = pluginStateStore.createPluginStateKeyedStore("memory-core", {
      namespace: "memory-host.event-cursors",
      maxEntries: 1_000,
      env,
    });
    await journal.register(entry.key, value);
    const cursorBefore = await cursors.entries();
    if (next === undefined) {
      await expect(append()).rejects.toThrow();
      expect(await cursors.entries()).toEqual(cursorBefore);
      expect(await journal.entries()).toHaveLength(1);
    } else {
      await append();
      expect(await cursors.entries()).toMatchObject([{ value: { lastSequence: next } }]);
    }
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
    db.exec(`CREATE TEMP TRIGGER fail_memory_journal BEFORE INSERT ON plugin_state_entries
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

  it("appends and reads typed workspace events", async () => {
    const workspaceDir = await createTempDir("memory-host-events-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: workspaceDir };

    await appendMemoryHostEvent(
      workspaceDir,
      {
        type: "memory.recall.recorded",
        timestamp: "2026-04-05T12:00:00.000Z",
        query: "glacier backup",
        resultCount: 1,
        results: [
          {
            path: "memory/2026-04-05.md",
            startLine: 1,
            endLine: 3,
            score: 0.9,
          },
        ],
      },
      { env },
    );
    await appendMemoryHostEvent(
      workspaceDir,
      {
        type: "memory.dream.completed",
        timestamp: "2026-04-05T11:00:00.000Z",
        phase: "light",
        outcome: "completed",
        lineCount: 4,
        storageMode: "both",
        inlinePath: path.join(workspaceDir, "memory", "2026-04-05.md"),
        reportPath: path.join(workspaceDir, "memory", "dreaming", "light", "2026-04-05.md"),
      },
      { env },
    );

    const events = await readMemoryHostEvents({ workspaceDir, env });
    const tail = await readMemoryHostEvents({ workspaceDir, limit: 1, env });

    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("memory.recall.recorded");
    expect(events[1]?.type).toBe("memory.dream.completed");
    if (events[1]?.type !== "memory.dream.completed") {
      throw new Error("expected dream completion event");
    }
    expect(events[1].outcome).toBe("completed");
    expect(tail).toHaveLength(1);
    expect(tail[0]?.type).toBe("memory.dream.completed");
  });

  it("keeps journal retention timestamps in the current wall-clock domain", async () => {
    const workspaceDir = await createTempDir("memory-host-events-created-at-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: workspaceDir };
    const now = Date.parse("2026-07-16T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    for (const query of ["first", "second"]) {
      await appendMemoryHostEvent(
        workspaceDir,
        {
          type: "memory.recall.recorded",
          timestamp: "2026-07-16T12:00:00.000Z",
          query,
          resultCount: 0,
          results: [],
        },
        { env },
      );
    }

    expect(
      (await listStoredMemoryHostEvents({ workspaceDir, env })).map((entry) => entry.createdAt),
    ).toEqual([now, now + 1]);
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

  it("bounds oversized diagnostic detail without failing the parent operation", async () => {
    const workspaceDir = await createTempDir("memory-host-events-bounded-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: workspaceDir };
    const results = Array.from({ length: 100 }, (_, index) => ({
      path: `memory/${"wide-path-".repeat(100)}${index}.md`,
      startLine: index + 1,
      endLine: index + 2,
      score: 0.9,
    }));

    await expect(
      appendMemoryHostEvent(
        workspaceDir,
        {
          type: "memory.recall.recorded",
          timestamp: "2026-04-05T12:00:00.000Z",
          query: "🔥".repeat(20_000),
          resultCount: results.length,
          results,
        },
        { env },
      ),
    ).resolves.toBeUndefined();

    const [event] = await readMemoryHostEventRecords({ workspaceDir, env });
    expect(event).toMatchObject({
      type: "memory.recall.recorded",
      resultCount: 100,
      storageTruncated: true,
    });
    if (event?.type !== "memory.recall.recorded") {
      throw new Error("expected bounded recall event");
    }
    expect(event.results).toHaveLength(10);
    expect(Buffer.byteLength(JSON.stringify(event), "utf8")).toBeLessThanOrEqual(8 * 1024);
  });

  it("validates only the retained prefix of an oversized event", () => {
    const result = {
      path: "memory/2026-04-05.md",
      startLine: 1,
      endLine: 2,
      score: 0.9,
    };
    const normalized = normalizeMemoryHostEventRecordForStorage({
      type: "memory.recall.recorded",
      timestamp: "2026-04-05T12:00:00.000Z",
      query: "bounded tail",
      resultCount: 11,
      results: [...Array.from({ length: 10 }, () => result), { path: 42 }],
    });

    expect(normalized).toMatchObject({ storageTruncated: true });
    expect(normalized?.type === "memory.recall.recorded" ? normalized.results : []).toHaveLength(
      10,
    );
  });

  it.each([
    { name: "unknown event type", value: { type: "memory.unknown", timestamp: "now" } },
    {
      name: "malformed retained result",
      value: {
        type: "memory.recall.recorded",
        timestamp: "now",
        query: "invalid",
        resultCount: 1,
        results: [{ path: 42 }],
      },
    },
  ])("rejects $name", ({ value }) => {
    expect(normalizeMemoryHostEventRecordForStorage(value)).toBeNull();
  });

  it("rotates old events without evicting the workspace sequence cursor", async () => {
    const workspaceDir = await createTempDir("memory-host-events-rotation-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: workspaceDir };
    setMaxMemoryHostEventsForTests(3);
    let clock = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock--);

    for (let index = 1; index <= 5; index += 1) {
      await appendMemoryHostEvent(
        workspaceDir,
        {
          type: "memory.recall.recorded",
          timestamp: `2026-04-05T12:00:0${index}.000Z`,
          query: `event-${index}`,
          resultCount: 0,
          results: [],
        },
        { env },
      );
    }

    const events = await readMemoryHostEventRecords({ workspaceDir, env });
    expect(
      events.map((event) => (event.type === "memory.recall.recorded" ? event.query : "")),
    ).toEqual(["event-3", "event-4", "event-5"]);
  });

  it("rotates events by namespace append order across workspaces", async () => {
    const stateDir = await createTempDir("memory-host-events-shared-retention-");
    const workspaceA = path.join(stateDir, "workspace-a");
    const workspaceB = path.join(stateDir, "workspace-b");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    setMaxMemoryHostEventsForTests(3);

    const appendRecall = async (workspaceDir: string, query: string) => {
      await appendMemoryHostEvent(
        workspaceDir,
        {
          type: "memory.recall.recorded",
          timestamp: "2026-04-05T12:00:00.000Z",
          query,
          resultCount: 0,
          results: [],
        },
        { env },
      );
    };
    await appendRecall(workspaceA, "a-1");
    await appendRecall(workspaceA, "a-2");
    await appendRecall(workspaceA, "a-3");
    await appendRecall(workspaceB, "b-1");
    await appendRecall(workspaceA, "a-4");

    const workspaceBEvents = await readMemoryHostEventRecords({
      workspaceDir: workspaceB,
      env,
    });
    expect(
      workspaceBEvents.map((event) => (event.type === "memory.recall.recorded" ? event.query : "")),
    ).toEqual(["b-1"]);
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

  it("lists retired JSON cache files as persistent dedupe entries", async () => {
    const root = await createTempDir("openclaw-legacy-dedupe-");
    const legacyPath = path.join(root, "legacy.json");
    await fs.writeFile(
      legacyPath,
      JSON.stringify({
        fresh: 1_000,
        expired: 100,
        invalid: "bad",
      }),
    );

    await expect(
      listPersistentDedupeLegacyJsonFileEntries({
        filePath: legacyPath,
        ttlMs: 500,
        now: 1_100,
      }),
    ).resolves.toStrictEqual([
      {
        key: expect.stringMatching(/^k\.[a-f0-9]{32}$/),
        value: { key: "fresh", seenAt: 1_000 },
        ttlMs: 400,
      },
    ]);
  });

  it("treats malformed legacy JSON cache files as empty", async () => {
    const root = await createTempDir("openclaw-legacy-dedupe-malformed-");
    const legacyPath = path.join(root, "legacy.json");
    await fs.writeFile(legacyPath, "{not valid json");

    await expect(
      listPersistentDedupeLegacyJsonFileEntries({
        filePath: legacyPath,
        ttlMs: 500,
        now: 1_100,
      }),
    ).resolves.toStrictEqual([]);
  });

  it("warms empty namespaces and ignores retired JSON cache files", async () => {
    const root = await createTempDir("openclaw-dedupe-");
    const emptyReader = createDedupe(root, { ttlMs: 10_000 });
    expect(await emptyReader.warmup("nonexistent")).toBe(0);

    await fs.writeFile(path.join(root, "acct.json"), JSON.stringify({ "retired-msg": Date.now() }));

    const reader = createDedupe(root, { ttlMs: 1000 });
    expect(await reader.warmup("acct")).toBe(0);
    expect(await reader.checkAndRecord("retired-msg", { namespace: "acct" })).toBe(true);
  });
});

describe("createClaimableDedupe", () => {
  it("mirrors in-flight duplicates, serializes races, and records on commit", async () => {
    const dedupe = createClaimableDedupe({
      ttlMs: 10_000,
      memoryMaxSize: 100,
    });

    await expect(dedupe.claim("line:evt-1")).resolves.toEqual({ kind: "claimed" });
    const duplicate = await dedupe.claim("line:evt-1");
    expect(duplicate.kind).toBe("inflight");

    const commit = dedupe.commit("line:evt-1");
    await expect(commit).resolves.toBe(true);
    if (duplicate.kind === "inflight") {
      await expect(duplicate.pending).resolves.toBe(true);
    }
    await expect(dedupe.claim("line:evt-1")).resolves.toEqual({ kind: "duplicate" });

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

  it("rejects waiting duplicates when the active claim releases with an error", async () => {
    const dedupe = createClaimableDedupe({
      ttlMs: 10_000,
      memoryMaxSize: 100,
    });

    await expect(dedupe.claim("line:evt-2")).resolves.toEqual({ kind: "claimed" });
    const duplicate = await dedupe.claim("line:evt-2");
    expect(duplicate.kind).toBe("inflight");

    const failure = new Error("transient failure");
    dedupe.release("line:evt-2", { error: failure });
    if (duplicate.kind === "inflight") {
      await expect(duplicate.pending).rejects.toThrow("transient failure");
    }
    await expect(dedupe.claim("line:evt-2")).resolves.toEqual({ kind: "claimed" });
  });

  it("forgets committed claimable entries", async () => {
    const dedupe = createClaimableDedupe({
      ttlMs: 10_000,
      memoryMaxSize: 100,
    });

    await expect(dedupe.claim("line:evt-3")).resolves.toEqual({ kind: "claimed" });
    await expect(dedupe.commit("line:evt-3")).resolves.toBe(true);
    await expect(dedupe.claim("line:evt-3")).resolves.toEqual({ kind: "duplicate" });
    await expect(dedupe.forget("line:evt-3")).resolves.toBe(true);
    await expect(dedupe.claim("line:evt-3")).resolves.toEqual({ kind: "claimed" });
  });

  it("supports persistent-backed recent checks and warmup", async () => {
    const root = await createTempDir("openclaw-claimable-dedupe-");
    const writer = createClaimableDedupe({
      ttlMs: 10_000,
      memoryMaxSize: 100,
      pluginId: "test-claimable-dedupe",
      namespacePrefix: "test-claimable-dedupe",
      stateMaxEntries: 1000,
      env: { ...process.env, OPENCLAW_STATE_DIR: root },
    });

    await expect(writer.claim("m1", { namespace: "acct" })).resolves.toEqual({ kind: "claimed" });
    await expect(writer.commit("m1", { namespace: "acct" })).resolves.toBe(true);

    const reader = createClaimableDedupe({
      ttlMs: 10_000,
      memoryMaxSize: 100,
      pluginId: "test-claimable-dedupe",
      namespacePrefix: "test-claimable-dedupe",
      stateMaxEntries: 1000,
      env: { ...process.env, OPENCLAW_STATE_DIR: root },
    });

    expect(await reader.hasRecent("m1", { namespace: "acct" })).toBe(true);
    expect(await reader.warmup("acct")).toBe(1);
    await expect(reader.claim("m1", { namespace: "acct" })).resolves.toEqual({
      kind: "duplicate",
    });
    await expect(reader.forget("m1", { namespace: "acct" })).resolves.toBe(true);
    const afterForget = createClaimableDedupe({
      ttlMs: 10_000,
      memoryMaxSize: 100,
      pluginId: "test-claimable-dedupe",
      namespacePrefix: "test-claimable-dedupe",
      stateMaxEntries: 1000,
      env: { ...process.env, OPENCLAW_STATE_DIR: root },
    });
    await expect(afterForget.claim("m1", { namespace: "acct" })).resolves.toEqual({
      kind: "claimed",
    });
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
