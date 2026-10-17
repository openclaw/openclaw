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
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import {
  applySessionEntryLifecycleMutation,
  loadSessionEntry,
  loadTranscriptEventsSync,
  patchSessionEntryCore,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import {
  commitReplySessionInitialization,
  loadReplySessionInitializationSnapshot,
} from "./session-accessor.reset.js";
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

const day = 24 * 60 * 60 * 1_000;
type MaintenanceOptions = Parameters<typeof maintenance.applySessionEntryMaintenance>[1];
type PlanOptions = Omit<Partial<MaintenanceOptions>, "maintenanceConfig"> & {
  maintenanceConfig?: Partial<MaintenanceOptions["maintenanceConfig"]>;
};

function freezeTime() {
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now);
  return now;
}

function preserveKeys(capture: () => string[]) {
  const unregister = registerSessionMaintenancePreserveKeysProvider(async () => ({
    capture,
    dispose() {},
  }));
  onTestFinished(unregister);
  return unregister;
}

function makeStorePath() {
  return path.join(sessionDirs.make(), "agents", "main", "sessions", "sessions.json");
}

function createPlannerStore(entryCount = 0, updatedAt?: number) {
  const storePath = makeStorePath();
  const key = (index: number) => `agent:main:planner-${index}`;
  const scope = (index: number) => ({ sessionKey: key(index), storePath });
  const set = (index: number, entry: Partial<SessionEntry>) =>
    replaceSessionEntrySync(scope(index), {
      sessionId: `planner-${index}`,
      updatedAt: 1,
      ...entry,
    });
  for (let index = 0; index < entryCount; index += 1) {
    set(index, { updatedAt: updatedAt ?? index + 1 });
  }
  const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
    agentId: "main",
  }).path;
  if (!databasePath) {
    throw new Error("expected planner maintenance database path");
  }
  const database = openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
  database.db.exec("ANALYZE; PRAGMA analysis_limit = 37;");
  const load = (index: number) => loadSessionEntry(scope(index));
  const prepare = async () => {
    const preservation = await prepareSessionMaintenancePreservation(storePath);
    onTestFinished(preservation.dispose);
    return ({ maintenanceConfig, ...options }: PlanOptions = {}) =>
      runOpenClawAgentWriteTransaction(
        (owner) =>
          maintenance.applySessionEntryMaintenance(owner, {
            archiveDirectory: path.join(path.dirname(database.path), "archives"),
            storePath,
            preservation: preservation.capture,
            ...options,
            maintenanceConfig: { ...resolveMaintenanceConfigFromInput(), ...maintenanceConfig },
          }),
        { agentId: "main", path: database.path },
      );
  };
  const statistics = () =>
    database.db
      .prepare("SELECT stat FROM sqlite_stat1 WHERE idx = ?")
      .get("idx_agent_session_nodes_updated_at");
  return { database, storePath, key, scope, set, load, prepare, statistics };
}

function trackReads(
  database: ReturnType<typeof openOpenClawAgentDatabase>,
  name: string,
  matches: (sql: string) => boolean,
) {
  const tracker = trackSqliteStatementExecutions(
    requireNativeSqliteDatabase(database.db),
    [name],
    (sql) => (matches(sql) ? name : null),
  );
  onTestFinished(tracker.restore);
  return tracker;
}

function trackProtection(database: ReturnType<typeof openOpenClawAgentDatabase>) {
  return trackReads(database, "protection", (sql) =>
    sql.includes(
      'select "current_session_id", "parent_session_key", "session_key", "updated_at" from "session_nodes"',
    ),
  );
}

function expectUnarchived(entry: SessionEntry | undefined, expected: Partial<SessionEntry> = {}) {
  expect(entry).toMatchObject(expected);
  expect(entry?.archivedAt).toBeUndefined();
}

it("returns bounded finalization outcomes while preserving conflicts and duplicate plan entries", async () => {
  const { database, storePath, key, scope, set, load } = createPlannerStore();
  const options = { agentId: "main", path: database.path, env: process.env };
  const entries = [0, 1, 2].map((index) => {
    set(index, {
      skillsSnapshot: { prompt: "retained snapshot".repeat(1024), skills: [] },
    });
    return { sessionKey: key(index), expectedEntry: load(index)! };
  });
  const changed = entries[2]!;
  entries.push({
    sessionKey: entries[0]!.sessionKey,
    expectedEntry: { ...entries[0]!.expectedEntry, label: "stale duplicate" },
  });
  replaceSessionEntrySync(scope(2), { ...changed.expectedEntry, label: "newer" });
  const snapshots = trackReads(
    database,
    "snapshot",
    (sql) => /^select\b/i.test(sql) && /\bsession_entry_snapshots\b/i.test(sql),
  );
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
  const { database, scope, load, prepare } = createPlannerStore(32, Date.now());
  const target = scope(0);
  const maintain = await prepare();
  const inventory = trackProtection(database);
  for (let index = 0; index < 3; index += 1) {
    await patchSessionEntryCore(target, () => ({ label: `updated-${index}` }), {
      skipMaintenance: true,
    });
    const plan = maintain({ activeSessionKey: target.sessionKey });
    expect(plan).toMatchObject({ archived: 0, capped: 0, pruned: 0, entryRemovals: [] });
  }
  expect(load(0)?.label).toBe("updated-2");
  expect(inventory.rowCounts.protection).toBe(0);
});

it("preserves current provider keys without loading unrelated protection rows", async () => {
  const now = freezeTime();
  const expired = now - 40 * day;
  const { database, scope, set, load, prepare } = createPlannerStore(3, expired);
  set(2, { updatedAt: now });
  let protectedKey = scope(0).sessionKey;
  preserveKeys(() => [protectedKey]);
  const maintain = await prepare();
  const inventory = trackProtection(database);
  expect(maintain({ forceMaintenance: true }).archivedEntries).toEqual([
    { sessionKey: scope(1).sessionKey, sessionId: "planner-1" },
  ]);
  expectUnarchived(load(0), { sessionId: "planner-0" });

  protectedKey = scope(2).sessionKey;
  set(2, { updatedAt: expired });
  expect(maintain({ forceMaintenance: true }).archivedEntries).toEqual([
    { sessionKey: scope(0).sessionKey, sessionId: "planner-0" },
  ]);
  expectUnarchived(load(2), {
    sessionId: "planner-2",
    updatedAt: expired,
  });
  expect(inventory.rowCounts.protection).toBe(0);
});

it.each([false, true])(
  "loads only age-due maintenance candidates while preserving recent dashboard activity (forced capacity=%s)",
  async (forceMaintenance) => {
    const now = freezeTime();
    const { database, storePath, prepare } = createPlannerStore();
    const key = (name: string) => `agent:main:${name}`;
    const oldModel = key("explicit:model-run-00000000-0000-0000-0000-000000000001");
    const pressureModel = key("explicit:model-run-00000000-0000-0000-0000-000000000002");
    const fixtures: Array<[string, number, Partial<SessionEntry>?]> = [
      [key("normal-expired"), 31],
      [key("normal-not-due"), 10],
      [key("dashboard:expired"), 8],
      [key("dashboard:not-due"), 3],
      [key("dashboard:recent-activity"), 8, { lastActivityAt: now }],
      [oldModel, 31],
      [pressureModel, 10],
    ];
    for (const [index, [sessionKey, ageDays, entry]] of fixtures.entries()) {
      replaceSessionEntrySync(
        { sessionKey, storePath },
        { sessionId: `age-candidate-${index}`, updatedAt: now - ageDays * day, ...entry },
      );
    }
    const maintain = await prepare();
    const candidates = trackReads(
      database,
      "candidates",
      (sql) => sql.includes("json_group_object") && sql.includes('"session_nodes"'),
    );
    const plan = maintain({
      forceMaintenance,
      maintenanceConfig: { maxEntries: forceMaintenance ? 5 : 5_000 },
    });
    expect(plan.archivedEntries.map(({ sessionKey }) => sessionKey).toSorted()).toEqual([
      key("dashboard:expired"),
      key("normal-expired"),
    ]);
    expect(plan.entryRemovals.map(({ sessionKey }) => sessionKey).toSorted()).toEqual(
      forceMaintenance ? [oldModel, pressureModel] : [oldModel],
    );
    for (const name of ["normal-not-due", "dashboard:not-due", "dashboard:recent-activity"]) {
      expectUnarchived(loadSessionEntry({ sessionKey: key(name), storePath }));
    }
    expect(
      loadSessionEntry({ sessionKey: key("dashboard:recent-activity"), storePath }),
    ).toMatchObject({ lastActivityAt: now });
    expect(candidates.rowCounts.candidates).toBe(forceMaintenance ? 5 : 4);
  },
);

it("limits protection reads to active ancestry and preserves cyclic or missing parents", async () => {
  const now = freezeTime();
  const { database, key, set, load, prepare } = createPlannerStore(32, now);
  const expired = now - 40 * day;
  // Root 0; child 1 -> 2; cycle 3 <-> 4; child 5 -> absent 32; unrelated victim 6.
  const parents = [undefined, 2, undefined, 4, 3, 32, undefined];
  for (const [index, parent] of parents.entries()) {
    set(index, {
      updatedAt: expired,
      ...(parent === undefined ? {} : { parentSessionKey: key(parent) }),
    });
  }
  const maintain = await prepare();
  const inventory = trackProtection(database);
  const plan = maintain({
    activeSessionKeys: [key(0), key(1), key(3), key(5)],
  });
  expect(plan.archivedEntries).toEqual([{ sessionKey: key(6), sessionId: "planner-6" }]);
  for (const index of [0, 1, 2, 3, 4, 5]) {
    expectUnarchived(load(index), { sessionId: `planner-${index}` });
  }
  expect(inventory.rowCounts.protection).toBe(6);
});

it("resolves protection once before capping aged candidates", async () => {
  const { storePath, key, set, load, prepare } = createPlannerStore(6, Date.now());
  set(3, { parentSessionKey: key(5), updatedAt: Date.now() });
  set(2, { updatedAt: Date.now() - 8 * day });
  const admission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: ["planner-0"],
    assertAllowed: () => {},
  });
  const provider = vi.fn(() => [key(2)]);
  const unregister = preserveKeys(provider);
  try {
    await runExclusiveSessionLifecycleMutation("archive", {
      scope: storePath,
      identities: [key(1)],
      run: async () => {
        const maintain = await prepare();
        const plan = maintain({
          activeSessionKey: key(3),
          maintenanceConfig: { maxEntries: 1 },
        });
        expect(plan).toMatchObject({ archived: 1, capArchived: 1, capped: 1 });
        expect(load(4)).toMatchObject({
          archivedAt: expect.any(Number),
          archiveReason: "active-session-cap",
        });
        for (const index of [0, 1, 2, 3, 5]) {
          expectUnarchived(load(index), { sessionId: `planner-${index}` });
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
  const { storePath, prepare } = createPlannerStore();
  const now = freezeTime();
  const old = now - 10 * day;
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
  const unregister = preserveKeys(() => [key("live")]);
  const maintain = await prepare();
  const parse = vi.spyOn(JSON, "parse");
  try {
    const plan = maintain({
      maintenanceConfig: {
        archiveDashboardAfterMs: null,
        preserveRecentMs: 1_000,
        maxEntries: fixtures.length - victims.length,
      },
    });
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
    const { database, storePath, scope, prepare } = createPlannerStore(2);
    const target = { ...scope(0), sessionId: "planner-0" };
    const sibling = scope(1);
    const transcript = [{ type: "session", id: target.sessionId, content: "retained history" }];
    replaceTranscriptEventsSync(target, transcript);
    const before = readSessionStateDeleteSnapshot(database.db, target.sessionId);
    const maintain = await prepare();
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
    expect(maintain({ forceMaintenance: true }).archived).toBe(1);
    expect(loadSessionEntry(target)).toMatchObject({
      archivedAt: expect.any(Number),
      archiveReason: "age-retention",
    });
    expect(loadTranscriptEventsSync(target)).toEqual(transcript);
  },
);

it("does not rescan unrelated rows when a requested lifecycle removal does not match", async () => {
  const { storePath, scope, load } = createPlannerStore(2);
  const retained = { ...scope(1), sessionId: "planner-1" };
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
  expect(load(0)?.label).toBe("updated");
  expect(loadSessionEntry(retained)?.sessionId).toBe(retained.sessionId);
  expect(loadTranscriptEventsSync(retained)).toEqual(transcript);
});

it.for(["channel recording", "reply initialization"] as const)(
  "does not hold %s behind automatic session maintenance",
  async (operation, { signal }) => {
    const storePath = makeStorePath();
    const seedStale = (suffix: string) => {
      const sessionId = `maintenance-ingress${suffix}-stale`;
      const sessionKey = `agent:main:subagent:${sessionId}`;
      replaceSessionEntrySync({ sessionKey, storePath }, { sessionId, updatedAt: 1 });
      return sessionKey;
    };
    const laterKey = "agent:main:subagent:maintenance-ingress-later-stale";
    const finalized = createDeferredCore();
    void finalized.promise.catch(() => {});
    const finalize = maintenance.finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort;
    vi.spyOn(
      maintenance,
      "finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort",
    ).mockImplementation(async (...args) => {
      const includesLaterEntry = args[1].some((plan) =>
        plan.entryRemovals.some(({ sessionKey }) => sessionKey === laterKey),
      );
      const result = finalize(...args);
      if (includesLaterEntry) {
        void result.then(
          () => finalized.resolve(),
          (error) => finalized.reject(error),
        );
      }
      return result;
    });
    const staleKey = seedStale("");

    const materializationStarted = createDeferredCore();
    const materializationReleased = createDeferredCore();
    archiveMaterializationHook.beforeMaterialize = async () => {
      materializationStarted.resolve();
      await materializationReleased.promise;
    };

    const write = async (suffix: string) => {
      const sessionId = `maintenance-ingress${suffix}`;
      const sessionKey = `agent:main:discord:direct:${sessionId}`;
      if (operation === "reply initialization") {
        const target = { agentId: "main", storePath, sessionKey };
        const snapshot = await loadReplySessionInitializationSnapshot(target);
        const result = await commitReplySessionInitialization({
          ...target,
          activeSessionKey: sessionKey,
          expectedRevision: snapshot.revision,
          sessionEntry: { sessionId, updatedAt: Date.now() },
          maintenanceConfig: resolveMaintenanceConfigFromInput(),
        });
        expect(result.ok).toBe(true);
        expect(loadSessionEntry(target)?.sessionId).toBe(sessionId);
        return;
      }
      await recordInboundSession({
        storePath,
        sessionKey,
        ctx: {
          Body: "maintenance ingress proof",
          ChatType: "direct",
          From: `discord:${sessionId}`,
          Provider: "discord",
          SenderId: sessionId,
          To: "discord:bot",
        },
        updateLastRoute: {
          accountId: "default",
          channel: "discord",
          sessionKey,
          to: `user:${sessionId}`,
        },
        onRecordError(error) {
          throw error;
        },
      });
    };
    const entryWrite = write("");
    const firstCompleted = await Promise.race([
      entryWrite.then(() => "entry-write" as const),
      materializationStarted.promise.then(() => "maintenance" as const),
    ]);
    if (firstCompleted === "entry-write") {
      await materializationStarted.promise;
      seedStale("-later");
      await write("-later");
    }
    materializationReleased.resolve();
    await entryWrite;

    expect(firstCompleted).toBe("entry-write");
    // Join the second cleanup before inspecting its writes; worker startup can exceed polling deadlines.
    await racePromiseWithAbortSignal(finalized.promise, signal);
    expect(loadSessionEntry({ sessionKey: staleKey, storePath })).toBeUndefined();
    expect(loadSessionEntry({ sessionKey: laterKey, storePath })).toBeUndefined();
  },
);

it("refreshes planner statistics after bulk lifecycle cleanup", async () => {
  const { database, storePath, statistics } = createPlannerStore(66);
  expect(statistics()).toEqual({ stat: expect.stringMatching(/^66\b/u) });

  await expect(
    applySessionEntryLifecycleMutation({
      storePath,
      removals: Array.from({ length: 65 }, (_, index) => ({
        sessionKey: `agent:main:planner-${index + 1}`,
      })),
      skipMaintenance: true,
    }),
  ).resolves.toMatchObject({ afterCount: 1, removedEntries: 65 });

  expect(statistics()).toEqual({ stat: expect.stringMatching(/^1\b/u) });
  expect(database.db.prepare("PRAGMA analysis_limit").get()).toEqual({ analysis_limit: 37 });
});

it("rolls back planner statistics when maintenance ownership is revoked before commit", async () => {
  const { database, statistics } = createPlannerStore(66);
  const scope = { agentId: "main", path: database.path };
  runOpenClawAgentWriteTransaction((current) => {
    for (let index = 1; index < 66; index += 1) {
      deleteSessionEntryRows(current, `agent:main:planner-${index}`, { deleteOwnedWindows: true });
    }
  }, scope);
  expect(database.db.prepare("SELECT COUNT(*) AS count FROM session_nodes").get()).toEqual({
    count: 1,
  });
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
  expect(statistics()).toEqual({ stat: expect.stringMatching(/^66\b/u) });
  authorization.mockRestore();
  current = true;
  await maintenance.refreshSqliteSessionPlannerStatisticsBestEffort(scope, 65, {
    isCurrent: () => current,
  });
  expect(statistics()).toEqual({ stat: expect.stringMatching(/^1\b/u) });
  expect(database.db.prepare("PRAGMA analysis_limit").get()).toEqual({ analysis_limit: 37 });
});
