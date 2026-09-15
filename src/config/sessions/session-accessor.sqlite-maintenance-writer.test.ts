import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { recordInboundSession } from "../../channels/session.js";
import {
  beginSessionWorkAdmission,
  isSessionLifecycleMutationActive,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  applySessionEntryLifecycleMutation,
  cleanupSessionLifecycleArtifactsCore,
  loadSessionEntry,
  loadTranscriptEventsSync,
  patchSessionEntryCore,
  replaceSessionEntrySync,
  replaceTranscriptEventsSync,
} from "./session-accessor.js";
import { readSessionStateDeleteSnapshot } from "./session-accessor.sqlite-delete-snapshot.js";
import { deleteSessionEntryRows } from "./session-accessor.sqlite-entry-store.js";
import {
  applySessionEntryMaintenance,
  refreshSqliteSessionPlannerStatisticsBestEffort,
} from "./session-accessor.sqlite-maintenance.js";
import * as reclamationCommit from "./session-accessor.sqlite-reclamation-commit.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { registerSessionMaintenancePreserveKeysProvider } from "./store-maintenance-preserve.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";

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

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  archiveMaterializationHook.beforeMaterialize = undefined;
  closeOpenClawAgentDatabasesForTest();
});

function createPlannerStore(entryCount: number, updatedAt?: number) {
  const tempDir = tempDirs.make("openclaw-session-maintenance-planner-");
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

it("avoids inventory projection for sequential writes with no retention candidates", async () => {
  const { database, storePath } = createPlannerStore(32, Date.now());
  const target = { sessionKey: "agent:main:planner-0", storePath };
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
          applySessionEntryMaintenance(owner, {
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

it.each([false, true])(
  "resolves protection once before capping (aged candidates: %s)",
  async (aged) => {
    const { database, storePath } = createPlannerStore(6, Date.now());
    const key = (index: number) => `agent:main:planner-${index}`;
    const scope = (index: number) => ({ sessionKey: key(index), storePath });
    replaceSessionEntrySync(scope(3), {
      sessionId: "planner-3",
      parentSessionKey: key(5),
      updatedAt: Date.now(),
    });
    if (aged) {
      replaceSessionEntrySync(scope(2), {
        sessionId: "planner-2",
        updatedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
      });
    }
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: ["planner-0"],
      assertAllowed: () => {},
    });
    const provider = vi.fn(() => [key(2)]);
    const unregister = registerSessionMaintenancePreserveKeysProvider(provider);
    try {
      await runExclusiveSessionLifecycleMutation({
        scope: storePath,
        identities: [key(1)],
        run: async () => {
          const plan = runOpenClawAgentWriteTransaction(
            (owner) =>
              applySessionEntryMaintenance(owner, {
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
  },
);

it.each(["session-key", "session-id"] as const)(
  "preserves aged sessions during a lifecycle mutation and resumes retention afterward (%s)",
  async (identityKind) => {
    const { database, storePath } = createPlannerStore(2);
    const target = { sessionKey: "agent:main:planner-0", sessionId: "planner-0", storePath };
    const sibling = { sessionKey: "agent:main:planner-1", storePath };
    const transcript = [{ type: "session", id: target.sessionId, content: "retained history" }];
    replaceTranscriptEventsSync(target, transcript);
    const before = readSessionStateDeleteSnapshot(database.db, target.sessionId);
    const maintain = () =>
      runOpenClawAgentWriteTransaction(
        (owner) =>
          applySessionEntryMaintenance(owner, {
            archiveDirectory: path.join(path.dirname(database.path), "archives"),
            maintenanceConfig: resolveMaintenanceConfigFromInput(),
            storePath,
          }),
        { agentId: "main", path: database.path },
      );
    const identity = identityKind === "session-key" ? target.sessionKey : target.sessionId;

    await runExclusiveSessionLifecycleMutation({
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
    expect(maintain().archived).toBe(1);
    expect(loadSessionEntry(target)).toMatchObject({
      archivedAt: expect.any(Number),
      archiveReason: "age-retention",
    });
    expect(loadTranscriptEventsSync(target)).toEqual(transcript);
  },
);

it.each([false, true])(
  "does not rescan unrelated rows when no lifecycle removal matches (requested: %s)",
  async (requestRemoval) => {
    const { storePath } = createPlannerStore(2);
    const retained = { sessionKey: "agent:main:planner-1", sessionId: "planner-1", storePath };
    const transcript = [{ type: "session", id: retained.sessionId, content: "retained" }];
    replaceTranscriptEventsSync(retained, transcript);
    const parseSpy = vi.spyOn(JSON, "parse");
    await expect(
      applySessionEntryLifecycleMutation({
        storePath,
        skipMaintenance: true,
        removals: requestRemoval ? [{ sessionKey: "agent:main:missing" }] : [],
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
  },
);

it("releases the store writer before maintenance archive sizing completes", async () => {
  const tempDir = tempDirs.make("openclaw-session-maintenance-writer-");
  const storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  const removedKey = "agent:main:subagent:maintenance-sizing-removed";
  const writerKey = "agent:main:maintenance-sizing-writer";
  replaceSessionEntrySync(
    { sessionKey: removedKey, storePath },
    { sessionId: "maintenance-sizing-removed", updatedAt: 1 },
  );
  replaceTranscriptEventsSync(
    { sessionKey: removedKey, sessionId: "maintenance-sizing-removed", storePath },
    [{ type: "session", id: "maintenance-sizing-removed", content: "archive me" }],
  );
  replaceSessionEntrySync(
    { sessionKey: writerKey, storePath },
    { sessionId: "maintenance-sizing-writer", updatedAt: Date.now() },
  );

  let writerCompleted = false;
  let writerCompletedBeforeMaterialization = false;
  archiveMaterializationHook.beforeMaterialize = () => {
    writerCompletedBeforeMaterialization = writerCompleted;
  };

  const cleanup = applySessionEntryLifecycleMutation({
    storePath,
    maintenanceOverride: {
      maxEntries: 1,
      mode: "enforce",
      pruneAfterMs: Number.MAX_SAFE_INTEGER,
    },
  });
  const writer = applySessionEntryLifecycleMutation({
    storePath,
    skipMaintenance: true,
    upserts: [
      {
        sessionKey: writerKey,
        entry: {
          sessionId: "maintenance-sizing-writer",
          label: "progressed",
          updatedAt: Date.now(),
        },
      },
    ],
  }).then((result) => {
    writerCompleted = true;
    return result;
  });

  await expect(cleanup).resolves.toMatchObject({ capped: 1 });
  await writer;
  expect(loadSessionEntry({ sessionKey: writerKey, storePath })).toMatchObject({
    label: "progressed",
  });
  expect(writerCompletedBeforeMaterialization).toBe(true);
});

it("does not hold channel recording behind automatic session maintenance", async () => {
  const tempDir = tempDirs.make("openclaw-session-maintenance-ingress-");
  const storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  const staleSessionKey = "agent:main:subagent:maintenance-ingress-stale";
  replaceSessionEntrySync(
    { sessionKey: staleSessionKey, storePath },
    { sessionId: "maintenance-ingress-stale", updatedAt: 1 },
  );

  let signalMaterializationStarted = () => {};
  const materializationStarted = new Promise<void>((resolve) => {
    signalMaterializationStarted = resolve;
  });
  let releaseMaterialization = () => {};
  const materializationReleased = new Promise<void>((resolve) => {
    releaseMaterialization = resolve;
  });
  archiveMaterializationHook.beforeMaterialize = async () => {
    signalMaterializationStarted();
    await materializationReleased;
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
    materializationStarted.then(() => "maintenance" as const),
  ]);
  const laterStaleSessionKey = "agent:main:subagent:maintenance-ingress-later-stale";
  if (firstCompleted === "entry-write") {
    await materializationStarted;
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
  releaseMaterialization();
  await entryWrite;

  expect(firstCompleted).toBe("entry-write");
  await vi.waitFor(() => {
    expect(loadSessionEntry({ sessionKey: staleSessionKey, storePath })).toBeUndefined();
    if (firstCompleted === "entry-write") {
      expect(loadSessionEntry({ sessionKey: laterStaleSessionKey, storePath })).toBeUndefined();
    }
  });
});

it.each([
  {
    expected: { afterCount: 66, capArchived: 65, capped: 65 },
    expectedStat: /^66\b/u,
    name: "maintenance pruning",
    mutate: async (storePath: string) =>
      await applySessionEntryLifecycleMutation({
        storePath,
        maintenanceOverride: {
          maxEntries: 1,
          mode: "enforce",
          pruneAfterMs: Number.MAX_SAFE_INTEGER,
        },
      }),
  },
  {
    expected: { afterCount: 1, removedEntries: 65 },
    expectedStat: /^1\b/u,
    name: "explicit lifecycle cleanup",
    mutate: async (storePath: string) =>
      await applySessionEntryLifecycleMutation({
        storePath,
        removals: Array.from({ length: 65 }, (_, index) => ({
          sessionKey: `agent:main:planner-${index + 1}`,
        })),
        skipMaintenance: true,
      }),
  },
  {
    expected: { archivedTranscriptArtifacts: 0, removedEntries: 65 },
    expectedStat: /^1\b/u,
    name: "lifecycle artifact cleanup",
    mutate: async (storePath: string) =>
      await cleanupSessionLifecycleArtifactsCore({
        storePath,
        sessionKeySegmentPrefix: "planner-",
        transcriptContentMarker: "planner-marker",
        orphanTranscriptMinAgeMs: 1,
        nowMs: 66,
      }),
  },
])("refreshes planner statistics after bulk $name", async ({ expected, expectedStat, mutate }) => {
  const { database, storePath } = createPlannerStore(66);
  expect(
    database.db
      .prepare("SELECT stat FROM sqlite_stat1 WHERE idx = ?")
      .get("idx_agent_session_nodes_updated_at"),
  ).toEqual({ stat: expect.stringMatching(/^66\b/u) });

  await expect(mutate(storePath)).resolves.toMatchObject(expected);

  expect(
    database.db
      .prepare("SELECT stat FROM sqlite_stat1 WHERE idx = ?")
      .get("idx_agent_session_nodes_updated_at"),
  ).toEqual({ stat: expect.stringMatching(expectedStat) });
  expect(database.db.prepare("PRAGMA analysis_limit").get()).toEqual({ analysis_limit: 37 });
});

it("does not refresh planner statistics after one routine session deletion", async () => {
  const { database, storePath } = createPlannerStore(66);

  await expect(
    applySessionEntryLifecycleMutation({
      storePath,
      removals: [{ sessionKey: "agent:main:planner-65" }],
      skipMaintenance: true,
    }),
  ).resolves.toMatchObject({ afterCount: 65, removedEntries: 1 });

  expect(
    database.db
      .prepare("SELECT stat FROM sqlite_stat1 WHERE idx = ?")
      .get("idx_agent_session_nodes_updated_at"),
  ).toEqual({ stat: expect.stringMatching(/^66\b/u) });
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
  const authorize = reclamationCommit.withSqliteReclamationAuthorization;
  const authorization = vi
    .spyOn(reclamationCommit, "withSqliteReclamationAuthorization")
    .mockImplementation((buffer, owner, assertCurrent, run) =>
      authorize(buffer, owner, assertCurrent, (commit) =>
        run(() => {
          reachedCommit = true;
          current = false;
          return commit();
        }),
      ),
    );

  await refreshSqliteSessionPlannerStatisticsBestEffort(scope, 65, { isCurrent: () => current });
  expect(reachedCommit).toBe(true);
  expect(readStatistics()).toEqual({ stat: expect.stringMatching(/^66\b/u) });
  authorization.mockRestore();
  current = true;
  await refreshSqliteSessionPlannerStatisticsBestEffort(scope, 65, { isCurrent: () => current });
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

  await refreshSqliteSessionPlannerStatisticsBestEffort(
    { agentId: "main", path: database.path },
    9900,
  );

  expect(plan()).toEqual([expect.stringContaining("maintenance_probe_a")]);
});
