import path from "node:path";
import { afterAll, afterEach, expect, it, onTestFinished, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { recordInboundSession } from "../../channels/session.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import {
  beginSessionWorkAdmission,
  isSessionLifecycleMutationActive,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import {
  applySessionEntryLifecycleMutation,
  loadSessionEntry,
  loadTranscriptEventsSync,
  patchSessionEntryCore,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import { readSessionStateDeleteSnapshot } from "./session-accessor.sqlite-delete-snapshot.js";
import {
  runSqliteSessionDeletionTransaction,
  withSqliteSessionDeletions,
} from "./session-accessor.sqlite-deletion.js";
import { deleteSessionEntryRows } from "./session-accessor.sqlite-entry-store.js";
import { finalizeSessionMaintenanceInDatabase } from "./session-accessor.sqlite-maintenance-transaction.js";
import * as maintenance from "./session-accessor.sqlite-maintenance.js";
import { replaceTranscriptEventsSync } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import {
  prepareSessionMaintenancePreservation,
  registerSessionMaintenancePreserveKeysProvider,
} from "./store-maintenance-preserve.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

const archiveMaterializationHook = vi.hoisted(() => ({
  beforeMaterialize: undefined as (() => Promise<void> | void) | undefined,
}));

vi.mock("./session-accessor.sqlite-archive.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-archive.js")>();
  return {
    ...actual,
    materializeSessionStateDeletePlans: async (
      ...args: Parameters<typeof actual.materializeSessionStateDeletePlans>
    ) => {
      await archiveMaterializationHook.beforeMaterialize?.();
      return await actual.materializeSessionStateDeletePlans(...args);
    },
  };
});

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-session-maintenance-planner-");

afterEach(() => {
  vi.restoreAllMocks();
  archiveMaterializationHook.beforeMaterialize = undefined;
});

function createPlannerStore(entryCount: number, updatedAt?: number) {
  const tempDir = sessionDirs.make();
  const storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  for (let index = 0; index < entryCount; index += 1) {
    replaceSessionEntrySync(
      { sessionKey: `agent:main:planner-${index}`, storePath },
      { sessionId: `planner-${index}`, updatedAt: updatedAt ?? index + 1 },
    );
  }
  const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
    agentId: "main",
  }).path;
  if (!databasePath) {
    throw new Error("expected planner maintenance database path");
  }
  const database = openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
  database.db.exec("ANALYZE; PRAGMA analysis_limit = 37;");
  return { database, storePath };
}

it("returns bounded finalization outcomes while preserving conflicts and duplicate plan entries", async () => {
  const { database, storePath } = createPlannerStore(0);
  const options = { agentId: "main", path: database.path, env: process.env };
  const entries = [0, 1, 2].map((index) => {
    const sessionKey = `agent:main:finalization-${index}`;
    replaceSessionEntrySync(
      { sessionKey, storePath },
      {
        sessionId: `finalization-${index}`,
        updatedAt: 1,
        skillsSnapshot: { prompt: "retained snapshot".repeat(1024), skills: [] },
      },
    );
    return { sessionKey, expectedEntry: loadSessionEntry({ sessionKey, storePath })! };
  });
  const changed = entries[2]!;
  entries.push({
    sessionKey: entries[0]!.sessionKey,
    expectedEntry: { ...entries[0]!.expectedEntry, label: "stale duplicate" },
  });
  replaceSessionEntrySync(
    { sessionKey: changed.sessionKey, storePath },
    { ...changed.expectedEntry, label: "newer" },
  );
  const snapshots = trackSqliteStatementExecutions(database.db, ["snapshot"], (sql) =>
    /^select\b/i.test(sql) && /\bsession_entry_snapshots\b/i.test(sql) ? "snapshot" : null,
  );
  try {
    const result = await withSqliteSessionDeletions(
      options,
      entries.map(({ sessionKey, expectedEntry }) => ({ sessionKey, entry: expectedEntry })),
      async () =>
        runSqliteSessionDeletionTransaction(
          (current) =>
            finalizeSessionMaintenanceInDatabase(current, {
              kind: "maintenance-finalize",
              agentId: options.agentId,
              databaseOptions: options,
              entries,
              materializedPlans: [],
            }),
          options,
        ),
    );
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1024);
    expect(result.value.committedEntryIndices).toEqual([0, 1]);
    expect(snapshots.rowCounts.snapshot).toBeLessThanOrEqual(
      entries.length + result.value.committedEntryIndices.length,
    );
  } finally {
    snapshots.restore();
  }
  for (const { sessionKey } of entries.slice(0, 2)) {
    expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
  }
  expect(loadSessionEntry({ sessionKey: changed.sessionKey, storePath })).toEqual({
    ...changed.expectedEntry,
    label: "newer",
  });
  expect(database.db.prepare("SELECT count(*) AS count FROM session_windows").get()?.count).toBe(3);
});

it("avoids inventory projection for sequential writes with no retention candidates", async () => {
  const { database, storePath } = createPlannerStore(32, Date.now());
  const target = { sessionKey: "agent:main:planner-0", storePath };
  const preservation = await prepareSessionMaintenancePreservation(storePath);
  onTestFinished(preservation.dispose);
  const inventory = trackSqliteStatementExecutions(database.db, ["protection"], (sql) =>
    sql.includes(
      'select "current_session_id", "parent_session_key", "session_key", "updated_at" from "session_nodes"',
    )
      ? "protection"
      : null,
  );
  try {
    for (let index = 0; index < 3; index += 1) {
      await patchSessionEntryCore(target, () => ({ label: `updated-${index}` }), {
        skipMaintenance: true,
      });
      const plan = runOpenClawAgentWriteTransaction(
        (owner) =>
          maintenance.applySessionEntryMaintenance(owner, {
            preservation: preservation.capture,
            activeSessionKey: target.sessionKey,
            archiveDirectory: path.join(path.dirname(database.path), "archives"),
            maintenanceConfig: resolveMaintenanceConfigFromInput(),
            storePath,
          }),
        { agentId: "main", path: database.path },
      );
      expect(plan).toMatchObject({ archived: 0, capped: 0, pruned: 0, entryRemovals: [] });
    }
    expect(loadSessionEntry(target)?.label).toBe("updated-2");
    expect(inventory.rowCounts.protection).toBe(0);
  } finally {
    inventory.restore();
  }
});

it("resolves protection once before capping aged candidates", async () => {
  const { database, storePath } = createPlannerStore(6, Date.now());
  const key = (index: number) => `agent:main:planner-${index}`;
  const scope = (index: number) => ({ sessionKey: key(index), storePath });
  replaceSessionEntrySync(scope(3), {
    sessionId: "planner-3",
    parentSessionKey: key(5),
    updatedAt: Date.now(),
  });
  replaceSessionEntrySync(scope(2), {
    sessionId: "planner-2",
    updatedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
  });
  const admission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: ["planner-0"],
    assertAllowed: () => {},
  });
  const provider = vi.fn(() => [key(2)]);
  const unregister = registerSessionMaintenancePreserveKeysProvider(async () => ({
    capture: provider,
    dispose() {},
  }));
  try {
    await runExclusiveSessionLifecycleMutation("archive", {
      scope: storePath,
      identities: [key(1)],
      run: async () => {
        const preservation = await prepareSessionMaintenancePreservation(storePath);
        onTestFinished(preservation.dispose);
        const plan = runOpenClawAgentWriteTransaction(
          (owner) =>
            maintenance.applySessionEntryMaintenance(owner, {
              preservation: preservation.capture,
              activeSessionKey: key(3),
              archiveDirectory: path.join(path.dirname(database.path), "archives"),
              maintenanceConfig: {
                ...resolveMaintenanceConfigFromInput(),
                maxEntries: 1,
              },
              storePath,
            }),
          { agentId: "main", path: database.path },
        );
        expect(plan).toMatchObject({ archived: 1, capArchived: 1, capped: 1 });
        expect(loadSessionEntry(scope(4))).toMatchObject({
          archivedAt: expect.any(Number),
          archiveReason: "active-session-cap",
        });
        for (const index of [0, 1, 2, 3, 5]) {
          expect(loadSessionEntry(scope(index))).toMatchObject({ sessionId: `planner-${index}` });
          expect(loadSessionEntry(scope(index))?.archivedAt).toBeUndefined();
        }
        expect(provider).toHaveBeenCalledTimes(1);
      },
    });
  } finally {
    unregister();
    admission.release();
  }
});

it("caps only the oldest eligible activity ties without decoding unrelated payloads", async () => {
  const { database, storePath } = createPlannerStore(0);
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now);
  const old = now - 10 * 24 * 60 * 60 * 1_000;
  const key = (name: string) => `agent:main:bounded-${name}`;
  const untouchedPayload = "unselected-maintenance-payload".repeat(1_000);
  const fixtures: Array<[string, Partial<SessionEntry>]> = [
    ["oldest", { updatedAt: old + 1 }],
    ["tie-\uE000", { updatedAt: old + 2, lastInteractionAt: old + 10 }],
    ["tie-\u{10000}", { updatedAt: old + 3, lastActivityAt: old + 10 }],
    ["started", { sessionStartedAt: now }],
    [
      "pinned",
      {
        pinnedAt: old,
        sidebarRoot: true,
        spawnedBy: key("parent"),
        parentSessionKey: key("parent"),
      },
    ],
    ["locked", { modelSelectionLocked: true }],
    ["group", { chatType: "group" }],
    ["recent", { lastActivityAt: now }],
    ["live", {}],
    ["fresh", { updatedAt: now }],
  ];
  const victims = ["oldest", "tie-\u{10000}"].map(key);
  for (const [index, [name, entry]] of fixtures.entries()) {
    replaceSessionEntrySync(
      { sessionKey: key(name), storePath },
      {
        sessionId: `bounded-${index}`,
        updatedAt: old,
        label: victims.includes(key(name)) ? name : untouchedPayload,
        ...entry,
      },
    );
  }
  const unregister = registerSessionMaintenancePreserveKeysProvider(async () => ({
    capture: () => [key("live")],
    dispose() {},
  }));
  onTestFinished(unregister);
  const preservation = await prepareSessionMaintenancePreservation(storePath);
  onTestFinished(preservation.dispose);
  const parse = vi.spyOn(JSON, "parse");
  try {
    const plan = runOpenClawAgentWriteTransaction(
      (owner) =>
        maintenance.applySessionEntryMaintenance(owner, {
          preservation: preservation.capture,
          archiveDirectory: path.join(path.dirname(database.path), "archives"),
          maintenanceConfig: {
            ...resolveMaintenanceConfigFromInput(),
            archiveDashboardAfterMs: null,
            preserveRecentMs: 1_000,
            maxEntries: fixtures.length - victims.length,
          },
          storePath,
        }),
      { agentId: "main", path: database.path },
    );
    expect(plan.archivedEntries).toEqual([
      { sessionKey: key("oldest"), sessionId: "bounded-0" },
      { sessionKey: key("tie-\u{10000}"), sessionId: "bounded-2" },
    ]);
    expect(plan).toMatchObject({ archived: 2, capArchived: 2, capped: 2 });
    expect(parse.mock.calls.some(([serialized]) => serialized.includes(untouchedPayload))).toBe(
      false,
    );
  } finally {
    parse.mockRestore();
    unregister();
  }
  for (const [name] of fixtures) {
    expect(loadSessionEntry({ sessionKey: key(name), storePath })?.archivedAt !== undefined).toBe(
      victims.includes(key(name)),
    );
  }
});

it.each(["session-key", "session-id"] as const)(
  "preserves aged sessions during a lifecycle mutation and resumes retention afterward (%s)",
  async (identityKind) => {
    const { database, storePath } = createPlannerStore(2);
    const target = { sessionKey: "agent:main:planner-0", sessionId: "planner-0", storePath };
    const sibling = { sessionKey: "agent:main:planner-1", storePath };
    const transcript = [{ type: "session", id: target.sessionId, content: "retained history" }];
    replaceTranscriptEventsSync(target, transcript);
    const before = readSessionStateDeleteSnapshot(database.db, target.sessionId);
    const preservation = await prepareSessionMaintenancePreservation(storePath);
    onTestFinished(preservation.dispose);
    const maintain = (forceMaintenance = false) =>
      runOpenClawAgentWriteTransaction(
        (owner) =>
          maintenance.applySessionEntryMaintenance(owner, {
            preservation: preservation.capture,
            forceMaintenance,
            archiveDirectory: path.join(path.dirname(database.path), "archives"),
            maintenanceConfig: resolveMaintenanceConfigFromInput(),
            storePath,
          }),
        { agentId: "main", path: database.path },
      );
    const identity = identityKind === "session-key" ? target.sessionKey : target.sessionId;

    await runExclusiveSessionLifecycleMutation("archive", {
      scope: storePath,
      identities: [identity],
      run: async () => {
        expect(isSessionLifecycleMutationActive(storePath, [identity])).toBe(true);
        const plan = maintain();
        expect(
          loadSessionEntry(target)?.archivedAt,
          "active lifecycle target must remain unarchived",
        ).toBeUndefined();
        expect(loadSessionEntry(sibling)).toMatchObject({
          archivedAt: expect.any(Number),
          archiveReason: "age-retention",
        });
        expect(plan.archived).toBe(1);
        expect(readSessionStateDeleteSnapshot(database.db, target.sessionId)).toEqual(before);
        expect(loadTranscriptEventsSync(target)).toEqual(transcript);
      },
    });

    expect(isSessionLifecycleMutationActive(storePath, [identity])).toBe(false);
    expect(maintain(true).archived).toBe(1);
    expect(loadSessionEntry(target)).toMatchObject({
      archivedAt: expect.any(Number),
      archiveReason: "age-retention",
    });
    expect(loadTranscriptEventsSync(target)).toEqual(transcript);
  },
);

it("does not rescan unrelated rows when a requested lifecycle removal does not match", async () => {
  const { storePath } = createPlannerStore(2);
  const retained = { sessionKey: "agent:main:planner-1", sessionId: "planner-1", storePath };
  const transcript = [{ type: "session", id: retained.sessionId, content: "retained" }];
  replaceTranscriptEventsSync(retained, transcript);
  const parseSpy = vi.spyOn(JSON, "parse");
  await expect(
    applySessionEntryLifecycleMutation({
      storePath,
      skipMaintenance: true,
      removals: [{ sessionKey: "agent:main:missing" }],
      upserts: [
        {
          sessionKey: "agent:main:planner-0",
          buildEntry: async ({ currentEntry }) => ({ ...currentEntry!, label: "updated" }),
        },
      ],
    }),
  ).resolves.toMatchObject({
    afterCount: 2,
    removedEntries: 0,
    archivedTranscriptDirectories: [],
  });

  // Allow the builder snapshot and before/after counts, but no unused deletion scans.
  expect(
    parseSpy.mock.calls.filter(([serialized]) => serialized.includes('"planner-1"')).length,
  ).toBeLessThanOrEqual(3);
  parseSpy.mockRestore();
  expect(loadSessionEntry({ sessionKey: "agent:main:planner-0", storePath })?.label).toBe(
    "updated",
  );
  expect(loadSessionEntry(retained)?.sessionId).toBe(retained.sessionId);
  expect(loadTranscriptEventsSync(retained)).toEqual(transcript);
});

it("does not hold channel recording behind automatic session maintenance", async ({ signal }) => {
  const tempDir = sessionDirs.make();
  const storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  const staleSessionKey = "agent:main:subagent:maintenance-ingress-stale";
  const laterStaleSessionKey = "agent:main:subagent:maintenance-ingress-later-stale";
  const finalized = createDeferredCore();
  void finalized.promise.catch(() => {});
  const finalize = maintenance.finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort;
  vi.spyOn(
    maintenance,
    "finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort",
  ).mockImplementation(async (...args) => {
    const includesLaterEntry = args[1].some((plan) =>
      plan.entryRemovals.some(({ sessionKey }) => sessionKey === laterStaleSessionKey),
    );
    try {
      const result = await finalize(...args);
      if (includesLaterEntry) {
        finalized.resolve();
      }
      return result;
    } catch (error) {
      if (includesLaterEntry) {
        finalized.reject(error);
      }
      throw error;
    }
  });
  replaceSessionEntrySync(
    { sessionKey: staleSessionKey, storePath },
    { sessionId: "maintenance-ingress-stale", updatedAt: 1 },
  );

  const materializationStarted = createDeferredCore();
  const materializationReleased = createDeferredCore();
  archiveMaterializationHook.beforeMaterialize = async () => {
    materializationStarted.resolve();
    await materializationReleased.promise;
  };

  const entryWrite = recordInboundSession({
    storePath,
    sessionKey: "agent:main:discord:direct:maintenance-ingress",
    ctx: {
      Body: "maintenance ingress proof",
      ChatType: "direct",
      From: "discord:maintenance-ingress",
      Provider: "discord",
      SenderId: "maintenance-ingress",
      To: "discord:bot",
    },
    updateLastRoute: {
      accountId: "default",
      channel: "discord",
      sessionKey: "agent:main:discord:direct:maintenance-ingress",
      to: "user:maintenance-ingress",
    },
    onRecordError(error) {
      throw error;
    },
  });
  const firstCompleted = await Promise.race([
    entryWrite.then(() => "entry-write" as const),
    materializationStarted.promise.then(() => "maintenance" as const),
  ]);
  if (firstCompleted === "entry-write") {
    await materializationStarted.promise;
    replaceSessionEntrySync(
      { sessionKey: laterStaleSessionKey, storePath },
      { sessionId: "maintenance-ingress-later-stale", updatedAt: 1 },
    );
    await recordInboundSession({
      storePath,
      sessionKey: "agent:main:discord:direct:maintenance-ingress-later",
      ctx: {
        Body: "later maintenance ingress proof",
        ChatType: "direct",
        From: "discord:maintenance-ingress-later",
        Provider: "discord",
        SenderId: "maintenance-ingress-later",
        To: "discord:bot",
      },
      updateLastRoute: {
        accountId: "default",
        channel: "discord",
        sessionKey: "agent:main:discord:direct:maintenance-ingress-later",
        to: "user:maintenance-ingress-later",
      },
      onRecordError(error) {
        throw error;
      },
    });
  }
  materializationReleased.resolve();
  await entryWrite;

  expect(firstCompleted).toBe("entry-write");
  // Join the second cleanup before inspecting its writes; worker startup can exceed polling deadlines.
  await racePromiseWithAbortSignal(finalized.promise, signal);
  expect(loadSessionEntry({ sessionKey: staleSessionKey, storePath })).toBeUndefined();
  expect(loadSessionEntry({ sessionKey: laterStaleSessionKey, storePath })).toBeUndefined();
});

it("refreshes planner statistics after bulk lifecycle cleanup", async () => {
  const { database, storePath } = createPlannerStore(66);
  expect(
    database.db
      .prepare("SELECT stat FROM sqlite_stat1 WHERE idx = ?")
      .get("idx_agent_session_nodes_updated_at"),
  ).toEqual({ stat: expect.stringMatching(/^66\b/u) });

  await expect(
    applySessionEntryLifecycleMutation({
      storePath,
      removals: Array.from({ length: 65 }, (_, index) => ({
        sessionKey: `agent:main:planner-${index + 1}`,
      })),
      skipMaintenance: true,
    }),
  ).resolves.toMatchObject({ afterCount: 1, removedEntries: 65 });

  expect(
    database.db
      .prepare("SELECT stat FROM sqlite_stat1 WHERE idx = ?")
      .get("idx_agent_session_nodes_updated_at"),
  ).toEqual({ stat: expect.stringMatching(/^1\b/u) });
  expect(database.db.prepare("PRAGMA analysis_limit").get()).toEqual({ analysis_limit: 37 });
});

it("rolls back planner statistics when maintenance ownership is revoked before commit", async () => {
  const { database } = createPlannerStore(66);
  const scope = { agentId: "main", path: database.path };
  runOpenClawAgentWriteTransaction((current) => {
    for (let index = 1; index < 66; index += 1) {
      deleteSessionEntryRows(current, `agent:main:planner-${index}`, { deleteOwnedWindows: true });
    }
  }, scope);
  expect(database.db.prepare("SELECT COUNT(*) AS count FROM session_nodes").get()).toEqual({
    count: 1,
  });
  const readStatistics = () =>
    database.db
      .prepare("SELECT stat FROM sqlite_stat1 WHERE idx = ?")
      .get("idx_agent_session_nodes_updated_at");
  let current = true;
  let reachedCommit = false;
  const authorization = probe.admission(workerAdmission, (request, grant, callback) => {
    if (request.stage === "commit") {
      reachedCommit = true;
      current = false;
    }
    return callback(request, grant);
  });

  await maintenance.refreshSqliteSessionPlannerStatisticsBestEffort(scope, 65, {
    isCurrent: () => current,
  });
  expect(reachedCommit).toBe(true);
  expect(readStatistics()).toEqual({ stat: expect.stringMatching(/^66\b/u) });
  authorization.mockRestore();
  current = true;
  await maintenance.refreshSqliteSessionPlannerStatisticsBestEffort(scope, 65, {
    isCurrent: () => current,
  });
  expect(readStatistics()).toEqual({ stat: expect.stringMatching(/^1\b/u) });
  expect(database.db.prepare("PRAGMA analysis_limit").get()).toEqual({ analysis_limit: 37 });
});

it("refreshes the retained parent query planner after worker analysis", async () => {
  const { database } = createPlannerStore(1);
  database.db.exec(`
    CREATE TABLE maintenance_planner_probe (a INTEGER, b INTEGER, payload TEXT);
    CREATE INDEX maintenance_probe_a ON maintenance_planner_probe(a);
    CREATE INDEX maintenance_probe_b ON maintenance_planner_probe(b);
    WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<10000)
    INSERT INTO maintenance_planner_probe
      SELECT CASE WHEN i<=9900 THEN 1 ELSE i-9899 END,
        CASE WHEN i<=9900 THEN i+1 ELSE 1 END, 'synthetic' FROM n;
    PRAGMA analysis_limit=0;
    ANALYZE main;
  `);
  const plan = () =>
    database.db
      .prepare("EXPLAIN QUERY PLAN SELECT payload FROM maintenance_planner_probe WHERE a=1 AND b=1")
      .all()
      .map((row) => row.detail);
  expect(plan()).toEqual([expect.stringContaining("maintenance_probe_b")]);
  database.db.exec("DELETE FROM maintenance_planner_probe WHERE a=1");

  await maintenance.refreshSqliteSessionPlannerStatisticsBestEffort(
    { agentId: "main", path: database.path },
    9900,
  );

  expect(plan()).toEqual([expect.stringContaining("maintenance_probe_a")]);
});
