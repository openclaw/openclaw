import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { requireNodeSqlite, resolveNodeSqliteLocation } from "../../infra/node-sqlite.js";
import {
  captureStateDatabaseCoordinatorRuntime,
  resolveStateDatabaseCoordinatorPath,
} from "../../infra/state-database-coordinator.js";
import {
  beginSessionWorkAdmission,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { sessionChanges, type SessionRowChange } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  loadSessionEntry,
  replaceSessionEntrySync,
  replaceTranscriptEventsSync,
} from "./session-accessor.js";
import * as archiveWorker from "./session-accessor.sqlite-archive.js";
import type { SqliteSessionReclamationDiagnostics } from "./session-accessor.sqlite-contract.js";
import { patchSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import * as ageFacts from "./session-accessor.sqlite-maintenance-age.js";
import * as maintenance from "./session-accessor.sqlite-maintenance.js";
import * as reclamationCommit from "./session-accessor.sqlite-reclamation-commit.js";
import * as reclamationWorker from "./session-accessor.sqlite-reclamation-worker.js";
import * as reclamation from "./session-accessor.sqlite-reclamation.js";
import { registerSessionMaintenancePreserveKeysProvider } from "./store-maintenance-preserve.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";

afterEach(() => vi.restoreAllMocks());

function observeMaintenance(
  accept: (
    result: Awaited<
      ReturnType<
        typeof maintenance.finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort
      >
    >,
  ) => boolean = () => true,
) {
  const finalize = maintenance.finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort;
  const completed = createDeferredCore<Awaited<ReturnType<typeof finalize>>>();
  vi.spyOn(
    maintenance,
    "finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort",
  ).mockImplementation(async (...args) => {
    try {
      const result = await finalize(...args);
      if (accept(result)) {
        completed.resolve(result);
      }
      return result;
    } catch (error) {
      completed.reject(error);
      throw error;
    }
  });
  return completed.promise;
}

it.each([false, true])(
  "runs automatic maintenance row planning off-thread (removal: %s)",
  async (remove) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const active = { sessionKey: "agent:main:maintenance-worker-active", storePath };
      const stale = { sessionKey: "agent:main:subagent:maintenance-worker-stale", storePath };
      replaceSessionEntrySync(active, { sessionId: "active", updatedAt: Date.now() });
      if (remove) {
        replaceSessionEntrySync(stale, { sessionId: "stale", updatedAt: 1 });
        replaceTranscriptEventsSync({ ...stale, sessionId: "stale" }, [
          { type: "session", id: "stale", content: "synthetic maintenance archive" },
        ]);
      }
      const coordinatorPath = resolveNodeSqliteLocation(
        resolveStateDatabaseCoordinatorPath({
          databasePath: resolveOpenClawStateSqlitePath(state.env),
          runtimeDirectory: captureStateDatabaseCoordinatorRuntime().directory,
          uid: process.getuid?.(),
        }),
      );
      const completed = observeMaintenance();
      await patchSessionEntryCore(active, () => ({ label: "updated" }), {
        maintenanceConfig: resolveMaintenanceConfigFromInput({
          mode: "enforce",
          maxEntries: 100,
          pruneAfter: "1h",
        }),
      });
      const { DatabaseSync, StatementSync } = requireNodeSqlite();
      const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
      // oxlint-disable-next-line typescript/unbound-method -- Forward the native operation with its exact database receiver.
      const originalExec = DatabaseSync.prototype.exec;
      const executions: Array<{ database: DatabaseSync; location: string | null; sql: string }> =
        [];
      const exec = vi
        .spyOn(DatabaseSync.prototype, "exec")
        .mockImplementation(function (this: DatabaseSync, sql) {
          executions.push({ database: this, location: this.location(), sql });
          return Reflect.apply(originalExec, this, [sql]);
        });
      const statements = (["get", "all", "run", "iterate"] as const).map((method) =>
        vi.spyOn(StatementSync.prototype, method),
      );
      const preservation = vi.fn(() => []);
      const unregister = registerSessionMaintenancePreserveKeysProvider(preservation);
      const result = await completed.finally(unregister);
      const preparedSql = prepare.mock.calls.map(([query]) => query);
      const counts = {
        prepare: prepare.mock.calls.length,
        exec: exec.mock.calls.length,
        ...Object.fromEntries(
          statements.map((spy, index) => [
            ["get", "all", "run", "iterate"][index],
            spy.mock.calls.length,
          ]),
        ),
      };
      prepare.mockRestore();
      exec.mockRestore();
      statements.forEach((spy) => spy.mockRestore());
      console.info("automatic-maintenance parent SQL", { remove, ...counts });
      expect(
        preparedSql.filter((query) => /(?:from|update|into) "session_nodes"/iu.test(query)),
      ).toEqual([]);
      if (!remove) {
        // Worker admission retains a separate lifecycle lock. Planning must still
        // perform no parent SQL against session data or any other database.
        const coordinatorExecutions = executions.filter(
          ({ location }) => resolveNodeSqliteLocation(location ?? "") === coordinatorPath,
        );
        expect({ ...counts, exec: counts.exec - coordinatorExecutions.length }).toEqual({
          prepare: 0,
          exec: 0,
          get: 0,
          all: 0,
          run: 0,
          iterate: 0,
        });
        expect(coordinatorExecutions.map(({ sql }) => sql)).toEqual([
          "PRAGMA busy_timeout = 0; PRAGMA journal_mode = MEMORY; BEGIN EXCLUSIVE;",
          "ROLLBACK",
        ]);
        expect(new Set(coordinatorExecutions.map(({ database }) => database)).size).toBe(1);
        expect(preservation).not.toHaveBeenCalled();
      }
      expect(loadSessionEntry(active)?.label).toBe("updated");
      if (remove) {
        expect(result.pruned).toBe(1);
        expect(loadSessionEntry(stale)).toBeUndefined();
        expect(result.archivedTranscripts).toHaveLength(1);
      }
    });
  },
);

it.each(["provider", "work-key", "work-id", "lifecycle-key", "lifecycle-id", "ancestor"] as const)(
  "preserves %s protection through automatic worker planning",
  async (protection) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const active = { sessionKey: "agent:main:maintenance-protection-active", storePath };
      const protectedKey = "agent:main:subagent:maintenance-protected";
      const protectedId = "maintenance-protected-id";
      const aliasKey = "agent:main:subagent:maintenance-protected-alias";
      const sibling = "agent:main:subagent:maintenance-unprotected";
      replaceSessionEntrySync(active, { sessionId: "active", updatedAt: Date.now() });
      replaceSessionEntrySync(
        { sessionKey: protectedKey, storePath },
        {
          sessionId: protectedId,
          updatedAt: 1,
        },
      );
      if (protection.endsWith("-id")) {
        replaceSessionEntrySync(
          { sessionKey: aliasKey, storePath },
          {
            sessionId: protectedId,
            updatedAt: 1,
          },
        );
      }
      replaceSessionEntrySync(
        { sessionKey: sibling, storePath },
        {
          sessionId: "unprotected",
          updatedAt: 1,
        },
      );
      const run = async () => {
        const completed = observeMaintenance();
        await patchSessionEntryCore(
          active,
          () => ({
            label: "protected",
            ...(protection === "ancestor" ? { parentSessionKey: protectedKey } : {}),
          }),
          {
            maintenanceConfig: resolveMaintenanceConfigFromInput({
              mode: "enforce",
              maxEntries: 100,
              pruneAfter: "1s",
            }),
          },
        );
        await completed;
        expect(loadSessionEntry({ sessionKey: protectedKey, storePath })?.sessionId).toBe(
          protectedId,
        );
        expect(loadSessionEntry({ sessionKey: sibling, storePath })).toBeUndefined();
        if (protection.endsWith("-id")) {
          expect(loadSessionEntry({ sessionKey: aliasKey, storePath })?.sessionId).toBe(
            protectedId,
          );
        }
      };
      if (protection === "provider") {
        let reverse = false;
        const unregister = registerSessionMaintenancePreserveKeysProvider(() => {
          reverse = !reverse;
          const keys = [protectedKey.toUpperCase(), active.sessionKey];
          return reverse ? keys.toReversed() : keys;
        });
        try {
          await run();
        } finally {
          unregister();
        }
      } else if (protection === "ancestor") {
        await run();
      } else {
        const identity = protection.endsWith("-key") ? protectedKey : protectedId;
        if (protection.startsWith("lifecycle")) {
          await runExclusiveSessionLifecycleMutation({
            scope: storePath,
            identities: [identity],
            run,
          });
        } else {
          const lease = await beginSessionWorkAdmission({
            scope: storePath,
            identities: [identity],
            assertAllowed: () => {},
          });
          try {
            await run();
          } finally {
            lease.release();
          }
        }
      }
    });
  },
);

it("rolls back archive metadata when protection changes at planning commit", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const active = { sessionKey: "agent:main:maintenance-live-protection", storePath };
    const protectedKey = "agent:main:maintenance-newly-protected";
    const staleKey = "agent:main:maintenance-still-stale";
    replaceSessionEntrySync(active, { sessionId: "active", updatedAt: Date.now() });
    replaceSessionEntrySync(
      { sessionKey: protectedKey, storePath },
      { sessionId: "protected", updatedAt: 1 },
    );
    replaceSessionEntrySync(
      { sessionKey: staleKey, storePath },
      { sessionId: "stale", updatedAt: 1 },
    );
    let protectedNow = false;
    const unregister = registerSessionMaintenancePreserveKeysProvider(() =>
      protectedNow ? [protectedKey] : [],
    );
    const authorize = reclamationCommit.withSqliteReclamationAuthorization;
    vi.spyOn(reclamationCommit, "withSqliteReclamationAuthorization").mockImplementation(
      (buffer, database, assertCurrent, run) =>
        authorize(buffer, database, assertCurrent, (commit) =>
          run(() => {
            protectedNow = true;
            return commit();
          }),
        ),
    );
    try {
      const completed = observeMaintenance();
      await patchSessionEntryCore(active, () => ({ label: "updated" }), {
        maintenanceConfig: resolveMaintenanceConfigFromInput({
          mode: "enforce",
          pruneAfter: "1s",
          maxEntries: 100,
        }),
      });
      await completed;
      expect(protectedNow).toBe(true);
      expect(loadSessionEntry({ sessionKey: protectedKey, storePath })?.archivedAt).toBeUndefined();
      expect(loadSessionEntry({ sessionKey: staleKey, storePath })?.archivedAt).toEqual(
        expect.any(Number),
      );
    } finally {
      unregister();
    }
  });
});

it.each(
  (["backdate", "restore"] as const).flatMap((mutation) =>
    (["before-authorization", "after-settlement", "missing-after-settlement"] as const).map(
      (boundary) => ({ mutation, boundary }),
    ),
  ),
)(
  "keeps $mutation authority at $boundary across real Worker planning",
  async ({ mutation, boundary }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const active = { sessionKey: "agent:main:age-worker-active", storePath };
      const victim = { sessionKey: "agent:main:age-worker-victim", storePath };
      const policy = resolveMaintenanceConfigFromInput({
        mode: "enforce",
        maxEntries: 1,
        pruneAfter: "1s",
        preserveRecent: "1h",
      });
      // Cap pressure requires Worker admission even with a warm age fact. Recent
      // rows remain protected until the injected backdate/restore makes the victim old.
      replaceSessionEntrySync(
        { sessionKey: "agent:main:age-worker-pressure", storePath },
        { sessionId: "pressure", updatedAt: Date.now() },
      );
      replaceSessionEntrySync(active, { sessionId: "active", updatedAt: Date.now() });
      replaceSessionEntrySync(victim, {
        sessionId: "victim",
        updatedAt: mutation === "restore" ? 1 : Date.now(),
        ...(mutation === "restore"
          ? { archivedAt: 2, archiveReason: "age-retention" as const }
          : {}),
      });
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const warm = boundary !== "missing-after-settlement";
      if (warm) {
        const prepared = observeMaintenance();
        await patchSessionEntryCore(active, () => ({ label: "warm" }), {
          maintenanceConfig: policy,
        });
        await prepared;
        expect(ageFacts.readSessionEntryMaintenanceAgeFact(database.db, policy)).toBeDefined();
        vi.restoreAllMocks();
      } else {
        expect(ageFacts.readSessionEntryMaintenanceAgeFact(database.db, policy)).toBeUndefined();
      }
      let changed = false;
      const mutate = () => {
        changed = true;
        // This real synchronous writer does not increment the automatic kick generation.
        replaceSessionEntrySync(victim, { sessionId: "victim", updatedAt: 1 });
      };
      let reclaimedWorkers = 0;
      const spawn = archiveWorker.createSqliteTranscriptArchiveWorker;
      vi.spyOn(archiveWorker, "createSqliteTranscriptArchiveWorker").mockImplementation((data) => {
        if ("operation" in data && data.operation === "reclaim") {
          reclaimedWorkers += 1;
        }
        return spawn(data);
      });
      const withWorker = reclamationWorker.withSqliteReclamationWorker;
      vi.spyOn(reclamationWorker, "withSqliteReclamationWorker").mockImplementation(
        (options, claim, run, assertCurrent) =>
          withWorker(
            options,
            claim,
            async (worker) => {
              const execute = worker.run.bind(worker);
              const observer = vi.spyOn(worker, "run").mockImplementation((params) => {
                if (params.plan.kind !== "maintenance-plan") {
                  return execute(params);
                }
                if (boundary === "before-authorization" && !changed) {
                  mutate();
                }
                return execute({
                  ...params,
                  withWriteAdmission: (admit, admission) =>
                    params.withWriteAdmission(async (refusal) => {
                      const result = await admit(refusal);
                      if (
                        boundary !== "before-authorization" &&
                        result?.kind === "maintenance-plan" &&
                        !changed
                      ) {
                        // Native COMMIT has completed; parent result adoption has not run yet.
                        mutate();
                      }
                      return result;
                    }, admission),
                });
              });
              try {
                return await run(worker);
              } finally {
                observer.mockRestore();
              }
            },
            assertCurrent,
          ),
      );
      const adoptedAfterMutation: Array<ageFacts.SessionEntryMaintenanceAgeFact | undefined> = [];
      const reclaim = reclamation.runSqliteSessionReclamation;
      vi.spyOn(reclamation, "runSqliteSessionReclamation").mockImplementation((params) =>
        reclaim({
          ...params,
          onWorkerResult: (result) => {
            params.onWorkerResult?.(result);
            if (changed && result.kind === "maintenance-plan") {
              adoptedAfterMutation.push(
                ageFacts.readSessionEntryMaintenanceAgeFact(database.db, policy),
              );
            }
          },
        }),
      );
      const completed = observeMaintenance((result) => result.archived === 1);
      await patchSessionEntryCore(active, () => ({ label: "change during planning" }), {
        maintenanceConfig: policy,
      });
      await completed;
      expect(changed).toBe(true);
      expect(reclaimedWorkers).toBe(boundary === "after-settlement" ? 0 : 1);
      if (boundary !== "before-authorization") {
        expect(adoptedAfterMutation[0]).toBeUndefined();
      }
      expect(loadSessionEntry(victim)).toMatchObject({
        archivedAt: expect.any(Number),
        archiveReason: "age-retention",
      });
      expect(ageFacts.readSessionEntryMaintenanceAgeFact(database.db, policy)).toBeDefined();
    });
  },
);

it("adopts age facts before synchronous publication reentry", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const active = { sessionKey: "agent:main:age-publication-active", storePath };
    const victim = { sessionKey: "agent:main:age-publication-victim", storePath };
    const stale = { sessionKey: "agent:main:age-publication-stale", storePath };
    const policy = resolveMaintenanceConfigFromInput({
      mode: "enforce",
      maxEntries: 100,
      pruneAfter: "1d",
    });
    replaceSessionEntrySync(active, { sessionId: "active", updatedAt: Date.now() });
    replaceSessionEntrySync(victim, { sessionId: "victim", updatedAt: Date.now() });
    replaceSessionEntrySync(stale, { sessionId: "stale", updatedAt: 1 });
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    let reentered = false;
    const observed: Array<{ before: boolean; after: boolean }> = [];
    const unsubscribe = sessionChanges.subscribe((change) => {
      if (
        reentered ||
        !("sessionKey" in change) ||
        change.sessionKey !== stale.sessionKey ||
        change.storePath !== database.path
      ) {
        return;
      }
      reentered = true;
      const before = ageFacts.readSessionEntryMaintenanceAgeFact(database.db, policy) !== undefined;
      replaceSessionEntrySync(victim, { sessionId: "victim", updatedAt: 1 });
      observed.push({
        before,
        after: ageFacts.readSessionEntryMaintenanceAgeFact(database.db, policy) !== undefined,
      });
    });
    try {
      const completed = observeMaintenance(
        (result) => result.archived === 1 && loadSessionEntry(victim)?.archivedAt !== undefined,
      );
      await patchSessionEntryCore(active, () => ({ label: "publish" }), {
        maintenanceConfig: policy,
      });
      await completed;
      expect(observed).toEqual([{ before: true, after: false }]);
      expect(loadSessionEntry(victim)?.archivedAt).toEqual(expect.any(Number));
      expect(loadSessionEntry(stale)?.archivedAt).toEqual(expect.any(Number));
    } finally {
      unsubscribe();
    }
  });
});

it("publishes exact archived keys without worktrees after Worker planning", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const active = { sessionKey: "agent:main:keyed-active", storePath };
    const stale = { sessionKey: "agent:main:keyed-stale", storePath };
    replaceSessionEntrySync(active, { sessionId: "active", updatedAt: Date.now() });
    replaceSessionEntrySync(stale, { sessionId: "stale", updatedAt: 1 });
    const databaseOptions = { agentId: "main", env: state.env };
    const database = openOpenClawAgentDatabase(databaseOptions);
    const published: SessionRowChange[] = [];
    const unsubscribe = sessionChanges.subscribe((change) => published.push(change));
    const diagnostics = {};
    try {
      const result = await reclamation.runSqliteSessionReclamation({
        diagnostics,
        forceInProcess: false,
        plan: reclamation.createSessionMaintenancePlanningOperation({
          databaseOptions,
          input: {
            activeSessionKey: active.sessionKey,
            archiveDirectory: state.sessionsDir(),
            maintenance: resolveMaintenanceConfigFromInput({
              mode: "enforce",
              maxEntries: 100,
              pruneAfter: "1s",
            }),
            preservation: { providerKeys: [], workIdentities: [], lifecycleIdentities: [] },
            storePath,
          },
        }),
      });
      expect(diagnostics).toMatchObject({ workerThreadId: expect.any(Number) });
      expect(result).toMatchObject({
        kind: "maintenance-plan",
        value: { archived: 1, archivedSessionKeys: [stale.sessionKey], entryRemovals: [] },
      });
      expect(published).toEqual([
        { agentId: "main", storePath: database.path, sessionKey: stale.sessionKey },
      ]);
      expect(loadSessionEntry(stale)).toMatchObject({ archivedAt: expect.any(Number) });
      expect(loadSessionEntry(stale)?.worktree).toBeUndefined();
      expect(loadSessionEntry(active)?.archivedAt).toBeUndefined();
    } finally {
      unsubscribe();
    }
  });
});

it("publishes only committed removal keys after Worker finalization", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const removed = { sessionKey: "agent:main:keyed-removed", storePath };
    const changed = { sessionKey: "agent:main:keyed-changed", storePath };
    const removedEntry = { sessionId: "removed", updatedAt: 1 };
    const previousEntry = { sessionId: "changed", updatedAt: 1 };
    replaceSessionEntrySync(removed, removedEntry);
    replaceSessionEntrySync(changed, previousEntry);
    const databaseOptions = { agentId: "main", env: state.env };
    const database = openOpenClawAgentDatabase(databaseOptions);
    const plan = reclamation.createSessionMaintenanceFinalizationOperation({
      agentId: "main",
      databaseOptions,
      entries: [
        { sessionKey: removed.sessionKey, expectedEntry: loadSessionEntry(removed) },
        { sessionKey: changed.sessionKey, expectedEntry: loadSessionEntry(changed) },
      ],
      materializedPlans: [],
    });
    replaceSessionEntrySync(changed, { ...previousEntry, label: "changed after planning" });
    const published: SessionRowChange[] = [];
    const unsubscribe = sessionChanges.subscribe((change) => published.push(change));
    const diagnostics = {};
    try {
      const result = await reclamation.runSqliteSessionReclamation({
        diagnostics,
        forceInProcess: false,
        plan,
      });
      expect(diagnostics).toMatchObject({ workerThreadId: expect.any(Number) });
      expect(result).toMatchObject({
        kind: "maintenance-finalize",
        value: { changedEntries: [plan.entries[1]], committedEntries: [plan.entries[0]] },
      });
      expect(published).toEqual([
        { agentId: "main", storePath: database.path, sessionKey: removed.sessionKey },
      ]);
      expect(loadSessionEntry(removed)).toBeUndefined();
      expect(loadSessionEntry(changed)?.label).toBe("changed after planning");
    } finally {
      unsubscribe();
    }
  });
});

it.each(["no-op", "preservation", "statistics", "empty-finalization"] as const)(
  "keeps resident rows warm after %s Worker maintenance",
  async (operation) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const active = { sessionKey: "agent:main:publication-active", storePath };
      const stale = { sessionKey: "agent:main:publication-stale", storePath };
      replaceSessionEntrySync(active, { sessionId: "active", updatedAt: Date.now() });
      if (operation === "preservation") {
        replaceSessionEntrySync(stale, { sessionId: "stale", updatedAt: 1 });
      }
      const databaseOptions = { agentId: "main", env: state.env };
      const database = openOpenClawAgentDatabase(databaseOptions);
      const plan =
        operation === "statistics"
          ? reclamation.createSessionMaintenanceStatisticsOperation(databaseOptions)
          : operation === "empty-finalization"
            ? reclamation.createSessionMaintenanceFinalizationOperation({
                agentId: "main",
                databaseOptions,
                entries: [],
                materializedPlans: [],
              })
            : reclamation.createSessionMaintenancePlanningOperation({
                databaseOptions,
                input: {
                  activeSessionKey: active.sessionKey,
                  archiveDirectory: state.sessionsDir(),
                  maintenance: resolveMaintenanceConfigFromInput({
                    mode: "enforce",
                    maxEntries: 100,
                    pruneAfter: "1h",
                  }),
                  preservation: null,
                  storePath,
                },
              });
      const published: unknown[] = [];
      const unsubscribe = sessionChanges.subscribe((change) => {
        const scope = "all" in change ? change.scope : change;
        if (typeof scope === "object" && scope.storePath === database.path) {
          published.push(change);
        }
      });
      const completed = vi.fn();
      const diagnostics = {};
      try {
        const result = await reclamation.runSqliteSessionReclamation({
          diagnostics,
          forceInProcess: false,
          onWorkerResult: completed,
          plan,
        });
        expect(diagnostics).toMatchObject({ workerThreadId: expect.any(Number) });
        expect(result.kind).toBe(
          operation === "preservation" ? "maintenance-preservation-required" : plan.kind,
        );
        expect(completed).toHaveBeenCalledExactlyOnceWith(result);
        expect(published).toEqual([]);
        if (operation === "preservation") {
          expect(loadSessionEntry(stale)?.archivedAt).toBeUndefined();
        }
      } finally {
        unsubscribe();
      }
    });
  },
);

it.each(["retired predicate", "parent reload failure"] as const)(
  "preserves committed statistics and Worker reuse after %s",
  async (failure) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      replaceSessionEntrySync(
        { sessionKey: "agent:main:statistics-first", storePath },
        { sessionId: "first", updatedAt: Date.now() },
      );
      const databaseOptions = { agentId: "main", env: state.env };
      const database = openOpenClawAgentDatabase(databaseOptions);
      database.db.exec("ANALYZE; PRAGMA analysis_limit = 37;");
      const readStatistics = () =>
        database.db
          .prepare("SELECT stat FROM sqlite_stat1 WHERE idx = ?")
          .get("idx_agent_session_nodes_updated_at");
      expect(readStatistics()).toEqual({ stat: expect.stringMatching(/^1\b/u) });
      replaceSessionEntrySync(
        { sessionKey: "agent:main:statistics-second", storePath },
        { sessionId: "second", updatedAt: Date.now() },
      );
      let current = true;
      const fault = new Error(`synthetic post-commit ${failure}`);
      const execute = database.db.exec.bind(database.db);
      const reload = vi.spyOn(database.db, "exec").mockImplementation((sql) => {
        if (failure === "parent reload failure" && sql === "ANALYZE sqlite_schema;") {
          throw fault;
        }
        execute(sql);
      });
      const first: SqliteSessionReclamationDiagnostics = {};
      const result = await reclamation.runSqliteSessionReclamation({
        assertCommitAllowed: () => {
          if (!current) {
            throw fault;
          }
        },
        diagnostics: first,
        forceInProcess: false,
        onWorkerResult: () => {
          if (failure === "retired predicate") {
            current = false;
          }
        },
        plan: reclamation.createSessionMaintenanceStatisticsOperation(databaseOptions),
      });
      expect(result).toEqual({ kind: "maintenance-statistics", value: true });
      expect(first.workerThreadId).toEqual(expect.any(Number));
      expect(readStatistics()).toEqual({ stat: expect.stringMatching(/^2\b/u) });
      expect(reload.mock.calls.filter(([sql]) => sql === "ANALYZE sqlite_schema;")).toHaveLength(
        failure === "parent reload failure" ? 1 : 0,
      );
      expect(database.db.prepare("PRAGMA analysis_limit").get()).toEqual({ analysis_limit: 37 });
      reload.mockRestore();
      const second: SqliteSessionReclamationDiagnostics = {};
      await expect(
        reclamation.runSqliteSessionReclamation({
          diagnostics: second,
          forceInProcess: false,
          plan: reclamation.createSessionMaintenanceStatisticsOperation(databaseOptions),
        }),
      ).resolves.toEqual({ kind: "maintenance-statistics", value: true });
      expect(second.workerThreadId).toBe(first.workerThreadId);
    });
  },
);

it("replans incognito preservation discovery after rollback without a Worker", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const active = { sessionKey: "agent:main:dashboard:incognito-age-active" };
    const victim = { sessionKey: "agent:main:dashboard:incognito-age-victim" };
    const policy = resolveMaintenanceConfigFromInput({
      mode: "enforce",
      maxEntries: 100,
      pruneAfter: "1s",
      archiveDashboardAfter: "1s",
    });
    replaceSessionEntrySync(active, { sessionId: "active", updatedAt: Date.now() });
    replaceSessionEntrySync(victim, { sessionId: "victim", updatedAt: 1 });
    const results: string[] = [];
    const reclaim = reclamation.runSqliteSessionReclamation;
    vi.spyOn(reclamation, "runSqliteSessionReclamation").mockImplementation(async (params) => {
      const result = await reclaim(params);
      results.push(result.kind);
      return result;
    });
    const spawn = vi.spyOn(archiveWorker, "createSqliteTranscriptArchiveWorker");
    const completed = observeMaintenance((result) => result.archived === 1);
    await patchSessionEntryCore(active, () => ({ label: "in process" }), {
      maintenanceConfig: policy,
    });
    await completed;
    expect(results).toEqual(["maintenance-preservation-required", "maintenance-plan"]);
    expect(spawn).not.toHaveBeenCalled();
    expect(loadSessionEntry(victim)).toMatchObject({ archivedAt: expect.any(Number) });
  });
});

it("reuses parent cadence facts until their bounded foreign-write recheck", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const active = { sessionKey: "agent:main:age-recheck-active", storePath };
    const victim = { sessionKey: "agent:main:age-recheck-victim", storePath };
    const policy = resolveMaintenanceConfigFromInput({
      mode: "enforce",
      maxEntries: 100,
      pruneAfter: "1d",
    });
    replaceSessionEntrySync(active, { sessionId: "active", updatedAt: Date.now() });
    replaceSessionEntrySync(victim, { sessionId: "victim", updatedAt: Date.now() });
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const warm = observeMaintenance();
    await patchSessionEntryCore(active, () => ({ label: "warm" }), { maintenanceConfig: policy });
    await warm;
    const initial = ageFacts.readSessionEntryMaintenanceAgeFact(database.db, policy)!;
    expect(initial).toBeDefined();
    vi.restoreAllMocks();
    const foreign = new (requireNodeSqlite().DatabaseSync)(database.path);
    try {
      foreign
        .prepare(
          "UPDATE session_nodes SET updated_at = 1, entry_json = json_set(entry_json, '$.updatedAt', 1) WHERE session_key = ?",
        )
        .run(victim.sessionKey);
    } finally {
      foreign.close();
    }
    const dispatch = vi.spyOn(reclamation, "runSqliteSessionReclamation");
    const unchanged = observeMaintenance();
    await patchSessionEntryCore(active, () => ({ label: "before recheck" }), {
      maintenanceConfig: policy,
    });
    expect((await unchanged).archived).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
    expect(ageFacts.readSessionEntryMaintenanceAgeFact(database.db, policy)).toEqual(initial);
    expect(loadSessionEntry(victim)?.archivedAt).toBeUndefined();
    vi.restoreAllMocks();
    const clock = vi.spyOn(Date, "now").mockReturnValue(initial.recheckAt);
    try {
      const rechecked = observeMaintenance((result) => result.archived === 1);
      await patchSessionEntryCore(active, () => ({ label: "at recheck" }), {
        maintenanceConfig: policy,
      });
      await rechecked;
    } finally {
      clock.mockRestore();
    }
    expect(loadSessionEntry(victim)?.archivedAt).toEqual(expect.any(Number));
  });
});
