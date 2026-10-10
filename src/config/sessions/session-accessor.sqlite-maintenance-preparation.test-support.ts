import { statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import * as sqlite from "../../infra/node-sqlite.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import * as agentExecution from "../../state/openclaw-agent-execution.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { loadSessionEntry, replaceSessionEntrySync } from "./session-accessor.js";
import { runExclusiveSqliteTranscriptArchiveWorker } from "./session-accessor.sqlite-archive.js";
import type { SqliteSessionReclamationDiagnostics } from "./session-accessor.sqlite-contract.js";
import { patchSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import type { SqliteSessionReclamationPlan } from "./session-accessor.sqlite-lifecycle-types.js";
import {
  maintenancePreparationFixture,
  observeSessionMaintenancePlanningWorker,
} from "./session-accessor.sqlite-maintenance.test-support.js";
import { runSqliteSessionReclamation } from "./session-accessor.sqlite-reclamation-run.js";
import {
  createSessionMaintenanceStatisticsOperation,
  createSessionMaintenanceFinalizationOperation,
  resolveSessionReclamationDatabaseOptions,
} from "./session-accessor.sqlite-reclamation.js";
import { applySessionEntryExactReplacements } from "./session-accessor.sqlite-replacement-projection.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";

export function registerSessionMaintenancePreparationTests() {
  it("rechecks a committed worker backdate before accepting a read-only maintenance age", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const active = { sessionKey: "agent:main:readonly-age-active", storePath };
      const victim = { sessionKey: "agent:main:readonly-age-victim", storePath };
      replaceSessionEntrySync(active, { sessionId: "active", updatedAt: Date.now() });
      replaceSessionEntrySync(victim, { sessionId: "victim", updatedAt: Date.now() });
      const databaseOptions = resolveSessionReclamationDatabaseOptions({
        agentId: "main",
        env: state.env,
      });
      const maintenance = resolveMaintenanceConfigFromInput({
        mode: "enforce",
        maxEntries: 100,
        pruneAfter: "1h",
      });
      let assertConsumedPlan: (() => void) | undefined;
      const consume = vi.fn((_read: unknown, assertCurrent: () => void) => {
        assertCurrent();
        assertConsumedPlan = assertCurrent;
      });
      const result = await runSqliteSessionReclamation({
        forceInProcess: false,
        consumeReadOnlyMaintenancePlan: consume,
        plan: {
          kind: "maintenance-plan",
          databaseOptions,
          materializedPlans: [],
          input: {
            activeSessionKey: active.sessionKey,
            archiveDirectory: state.sessionsDir(),
            maintenance,
            preservation: { providerKeys: [], workIdentities: [], lifecycleIdentities: [] },
            storePath,
          },
        },
      });
      expect(result.kind).toBe("maintenance-plan");
      if (result.kind !== "maintenance-plan") {
        throw new Error("Expected maintenance planning result");
      }
      expect(consume).toHaveBeenCalledOnce();
      expect(result.nextAt).toBeGreaterThan(Date.now());
      expect(() => expectDefined(assertConsumedPlan, "consumed maintenance guard")()).toThrow(
        "Session maintenance consumption has ended",
      );
      if (result.readOnlyInput) {
        // An unchanged planning result can publish its deadline without replanning.
        const finalAge = await runSqliteSessionReclamation({
          forceInProcess: false,
          plan: {
            kind: "maintenance-age",
            databaseOptions,
            materializedPlans: [],
            maintenance,
            readOnly: { input: result.readOnlyInput, snapshot: result.ageSnapshot },
          },
        });
        expect(finalAge).toEqual({ kind: "maintenance-age", nextAt: expect.any(Number) });
        if (finalAge.kind === "maintenance-age") {
          expect(finalAge.nextAt).toBeGreaterThan(Date.now());
        }
      }
      await patchSessionEntryCore(victim, () => ({ sessionId: "victim", updatedAt: 1 }), {
        replaceEntry: true,
        workerGuard: {},
        skipMaintenance: true,
      });
      await expect(
        runSqliteSessionReclamation({
          forceInProcess: false,
          plan: {
            kind: "maintenance-age",
            databaseOptions,
            materializedPlans: [],
            maintenance,
            expected: result.ageSnapshot,
            ...(result.readOnlyInput
              ? { readOnly: { input: result.readOnlyInput, snapshot: result.ageSnapshot } }
              : {}),
          },
        }),
      ).resolves.toEqual({ kind: "maintenance-plan-stale" });
      const database = openOpenClawAgentDatabase(databaseOptions);
      expect(
        database.db
          .prepare("SELECT archived_at FROM session_nodes WHERE session_key = ?")
          .get(victim.sessionKey),
      ).toEqual({ archived_at: null });
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
        const originalFile = statSync(database.path, { bigint: true });
        const plan: SqliteSessionReclamationPlan =
          operation === "statistics"
            ? createSessionMaintenanceStatisticsOperation(databaseOptions)
            : operation === "empty-finalization"
              ? createSessionMaintenanceFinalizationOperation({
                  agentId: "main",
                  databaseOptions,
                  entries: [],
                  materializedPlans: [],
                })
              : {
                  kind: "maintenance-plan",
                  databaseOptions: resolveSessionReclamationDatabaseOptions(databaseOptions),
                  materializedPlans: [],
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
                };
        const published: unknown[] = [];
        const unsubscribe = sessionChanges.subscribe((change) => {
          const scope = "all" in change ? change.scope : change;
          if (typeof scope === "object" && scope.storePath === database.path) {
            published.push(change);
          }
        });
        const completed = vi.fn();
        const diagnostics = {};
        const capture = agentExecution.captureOpenClawAgentDatabaseExecution;
        const actorCalls: Array<() => number> = [];
        vi.spyOn(agentExecution, "captureOpenClawAgentDatabaseExecution").mockImplementation(
          (...args) => {
            const execution = capture(...args);
            const run = vi.spyOn(execution, "runExisting");
            actorCalls.push(() => run.mock.calls.length);
            return execution;
          },
        );
        try {
          const result = await runSqliteSessionReclamation({
            diagnostics,
            forceInProcess: false,
            onWorkerResult: completed,
            plan,
          });
          expect(diagnostics).toMatchObject({ workerThreadId: expect.any(Number) });
          expect(result.kind).toBe(
            operation === "preservation" ? "maintenance-preservation-required" : plan.kind,
          );
          expect(completed).toHaveBeenCalledExactlyOnceWith(
            result,
            `${originalFile.dev}:${originalFile.ino}`,
          );
          expect(published).toEqual([]);
          if (operation === "no-op" || operation === "preservation") {
            expect(actorCalls.reduce((count, readCount) => count + readCount(), 0)).toBe(0);
          }
          if (operation === "preservation") {
            expect(loadSessionEntry(stale)?.archivedAt).toBeUndefined();
          }
        } finally {
          unsubscribe();
        }
      });
    },
  );

  it.for(["maintenance-plan", "maintenance-statistics"] as const)(
    "runs cold %s without opening or querying a host database",
    async (kind, { signal }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const fixture = maintenancePreparationFixture(state);
        const plan =
          kind === "maintenance-plan"
            ? fixture.plan
            : createSessionMaintenanceStatisticsOperation(fixture.plan.databaseOptions);
        const opened = vi.spyOn(sqlite, "openNodeSqliteDatabase");
        await closeOpenClawAgentDatabasesAsync();
        closeOpenClawAgentDatabasesForTest();
        opened.mockClear();
        const sql = observeHostDataSql();
        const diagnostics: SqliteSessionReclamationDiagnostics = {};
        const archiveEntered = createDeferredCore();
        const releaseArchive = createDeferredCore();
        let archiveSettled = false;
        const heldArchive = runExclusiveSqliteTranscriptArchiveWorker(async () => {
          archiveEntered.resolve();
          await releaseArchive.promise;
        });
        void heldArchive.then(
          () => {
            archiveSettled = true;
          },
          () => {
            archiveSettled = true;
          },
        );
        let pending: ReturnType<typeof runSqliteSessionReclamation> | undefined;
        let archive: PromiseSettledResult<Awaited<typeof heldArchive>>;
        try {
          await racePromiseWithAbortSignal(archiveEntered.promise, signal);
          pending = runSqliteSessionReclamation({
            plan,
            forceInProcess: false,
            diagnostics,
          });
          const result = await racePromiseWithAbortSignal(pending, signal);
          expect(archiveSettled).toBe(false);
          expect(result.kind).toBe(kind);
          expect(diagnostics.workerThreadId).toBeGreaterThan(0);
          expect(opened.mock.calls).toEqual([]);
          expect(sql.queries).toEqual([]);
          if (result.kind === "maintenance-plan") {
            expect(result.value.archived).toBe(1);
            expect(result.value.archivedEntries).toEqual(fixture.archivedEntries);
            expect(result.value.entryRemovals).toEqual([]);
          } else if (result.kind === "maintenance-statistics") {
            expect(result.value).toBe(true);
          }
        } finally {
          releaseArchive.resolve();
          [archive] = await Promise.allSettled([
            heldArchive,
            ...(pending ? [pending] : []),
          ] as const);
          sql.restore();
          opened.mockRestore();
        }
        if (archive.status === "rejected") {
          throw archive.reason;
        }
        expect(loadSessionEntry(fixture.active)?.sessionId).toBe("active");
        if (kind === "maintenance-plan") {
          expect(loadSessionEntry(fixture.stale)).toMatchObject({
            sessionId: "stale",
            archivedAt: expect.any(Number),
            archiveReason: "age-retention",
          });
        }
      });
    },
  );

  it("lets foreground changes to selected rows invalidate maintenance without caller-thread data SQL", async ({
    signal,
  }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { active, stale, database, plan, archivedEntries } =
        maintenancePreparationFixture(state);
      const prepared = createDeferredCore();
      const continuePreparation = createDeferredCore();
      const preparations: string[] = [];
      const released: string[] = [];
      const published: string[] = [];
      const unsubscribe = sessionChanges.subscribe((change) => {
        if (
          "sessionKey" in change &&
          change.storePath === database.path &&
          change.sessionKey === stale.sessionKey
        ) {
          published.push(change.sessionKey);
        }
      });
      observeSessionMaintenancePlanningWorker({
        async afterPrepare(id) {
          preparations.push(id);
          if (preparations.length === 1) {
            prepared.resolve();
            await continuePreparation.promise;
          }
        },
        afterRelease(id) {
          released.push(id);
        },
      });
      const sql = observeHostDataSql();
      const pending = runSqliteSessionReclamation({ forceInProcess: false, plan });
      let foreground: Promise<void> | undefined;
      let retry: ReturnType<typeof runSqliteSessionReclamation> | undefined;
      try {
        await racePromiseWithAbortSignal(
          Promise.race([
            prepared.promise,
            pending.then(() => {
              throw new Error("Maintenance completed without its preparation boundary");
            }),
          ]),
          signal,
        );
        foreground = applySessionEntryExactReplacements({
          storePath: database.path,
          sessionKeys: [stale.sessionKey],
          skipMaintenance: true,
          update: ([row]) => ({
            result: undefined,
            replacements: [
              {
                sessionKey: stale.sessionKey,
                entry: {
                  ...expectDefined(row, "foreground session row").entry,
                  label: "foreground progressed",
                },
              },
            ],
          }),
        });
        await racePromiseWithAbortSignal(foreground, signal);
        expect(released).toEqual([]);
        expect(published).toEqual([stale.sessionKey]);
        continuePreparation.resolve();
        await expect(pending).resolves.toEqual({ kind: "maintenance-plan-stale" });
        expect(released).toEqual([preparations[0]]);
        expect(published).toEqual([stale.sessionKey]);
        retry = runSqliteSessionReclamation({ forceInProcess: false, plan });
        await expect(retry).resolves.toMatchObject({
          kind: "maintenance-plan",
          value: { archived: 1, archivedEntries, entryRemovals: [] },
        });
        expect(preparations).toHaveLength(2);
        expect(preparations[0]).not.toBe(preparations[1]);
        expect(released).toEqual(preparations);
        expect(published).toEqual([stale.sessionKey, stale.sessionKey]);
        expect(sql.queries).toEqual([]);
      } finally {
        continuePreparation.resolve();
        await Promise.allSettled([pending, foreground, retry]);
        sql.restore();
        unsubscribe();
      }
      expect(loadSessionEntry(stale)?.label).toBe("foreground progressed");
      expect(loadSessionEntry(active)?.archivedAt).toBeUndefined();
      expect(loadSessionEntry(stale)?.archivedAt).toEqual(expect.any(Number));
    });
  });

  it.for(["caller revocation", "lost preparation reply"] as const)(
    "joins preparation cleanup after %s without discarding another caller's preparation",
    async (failure, { signal }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const { stale, plan, archivedEntries } = maintenancePreparationFixture(state);
        const firstPrepared = createDeferredCore();
        const secondPrepared = createDeferredCore();
        const releaseEntered = createDeferredCore();
        const continueFirst = createDeferredCore();
        const continueSecond = createDeferredCore();
        const continueRelease = createDeferredCore();
        const preparations: string[] = [];
        const released: string[] = [];
        const cancelled = new Error(`Maintenance ${failure} after native preparation`);
        observeSessionMaintenancePlanningWorker({
          async afterPrepare(id) {
            preparations.push(id);
            if (preparations.length === 1) {
              firstPrepared.resolve();
              await continueFirst.promise;
              if (failure === "lost preparation reply") {
                throw cancelled;
              }
            } else {
              secondPrepared.resolve();
              await continueSecond.promise;
            }
          },
          async beforeRelease(id) {
            if (id === preparations[0]) {
              releaseEntered.resolve();
              await continueRelease.promise;
            }
          },
          afterRelease(id) {
            released.push(id);
          },
        });
        let current = true;
        let settled = false;
        const published = vi.fn();
        const sql = observeHostDataSql();
        const first = runSqliteSessionReclamation({
          forceInProcess: false,
          plan,
          onWorkerResult: published,
          assertCommitAllowed() {
            if (!current) {
              throw cancelled;
            }
          },
        });
        const firstOutcome = first.then(
          (value) => {
            settled = true;
            return { kind: "returned" as const, value };
          },
          (error: unknown) => {
            settled = true;
            return { kind: "failed" as const, error };
          },
        );
        let second: ReturnType<typeof runSqliteSessionReclamation> | undefined;
        let excess: ReturnType<typeof runSqliteSessionReclamation> | undefined;
        const premature = firstOutcome.then(() => {
          throw new Error("Cancelled maintenance settled before its retained cleanup");
        });
        void premature.catch(() => {});
        try {
          await racePromiseWithAbortSignal(
            Promise.race([firstPrepared.promise, premature]),
            signal,
          );
          current = failure !== "caller revocation";
          continueFirst.resolve();
          await racePromiseWithAbortSignal(
            Promise.race([releaseEntered.promise, premature]),
            signal,
          );
          expect(settled).toBe(false);
          second = runSqliteSessionReclamation({ forceInProcess: false, plan });
          await racePromiseWithAbortSignal(
            Promise.race([
              secondPrepared.promise,
              second.then(() => {
                throw new Error("Sibling maintenance completed without preparation");
              }),
            ]),
            signal,
          );
          expect(preparations).toHaveLength(2);
          expect(preparations[0]).not.toBe(preparations[1]);
          expect(released).toEqual([]);
          expect(published).not.toHaveBeenCalled();
          excess = runSqliteSessionReclamation({ forceInProcess: false, plan });
          await expect(racePromiseWithAbortSignal(excess, signal)).rejects.toThrow(
            "Session maintenance preparation capacity is occupied",
          );
          expect(preparations).toHaveLength(2);
          expect(released).toHaveLength(1);
          const refusedId = expectDefined(released[0], "refused preparation discard");
          expect(preparations).not.toContain(refusedId);
          continueRelease.resolve();
          expect(await firstOutcome).toEqual({ kind: "failed", error: cancelled });
          expect(released).toEqual([refusedId, preparations[0]]);
          continueSecond.resolve();
          await expect(second).resolves.toMatchObject({
            kind: "maintenance-plan",
            value: { archived: 1, archivedEntries },
          });
          expect(released).toEqual([refusedId, ...preparations]);
          expect(published).not.toHaveBeenCalled();
          expect(sql.queries).toEqual([]);
        } finally {
          continueFirst.resolve();
          continueSecond.resolve();
          continueRelease.resolve();
          await Promise.allSettled([firstOutcome, second, excess]);
          sql.restore();
        }
        expect(loadSessionEntry(stale)?.archivedAt).toEqual(expect.any(Number));
      });
    },
  );
  it.runIf(process.platform !== "win32")(
    "joins the prepared native owner on path replacement before rejecting its caller",
    async ({ signal }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const { stale, database, plan, archivedEntries } = maintenancePreparationFixture(state);
        const successorPath = state.statePath("successor", "store.sqlite");
        replaceSessionEntrySync(
          { sessionKey: stale.sessionKey, storePath: successorPath },
          { sessionId: "successor", updatedAt: 1, label: "successor untouched" },
        );
        await closeOpenClawAgentDatabaseByPathAsync(successorPath);
        const successorBytes = await fs.readFile(successorPath);
        const heldPath = `${database.path}.held`;
        const replacementPath = `${database.path}.replacement`;
        await fs.writeFile(replacementPath, successorBytes);
        const prepared = createDeferredCore();
        const continuePreparation = createDeferredCore();
        let nativeClosed = false;
        let closeNative: (() => Promise<void>) | undefined;
        observeSessionMaintenancePlanningWorker({
          async afterPrepare(_id, native) {
            if (closeNative) {
              return;
            }
            const close = native.store.close.bind(native.store);
            closeNative = close;
            vi.spyOn(native.store, "close").mockImplementation(async () => {
              await close();
              nativeClosed = true;
            });
            prepared.resolve();
            await continuePreparation.promise;
          },
        });
        const sql = observeHostDataSql();
        const pending = runSqliteSessionReclamation({ forceInProcess: false, plan });
        const outcome = pending.then(
          (value) => ({ kind: "returned" as const, value, nativeClosed }),
          (error: unknown) => ({ kind: "failed" as const, error, nativeClosed }),
        );
        let originalMoved = false;
        let replacementInstalled = false;
        try {
          await racePromiseWithAbortSignal(
            Promise.race([
              prepared.promise,
              outcome.then(() => {
                throw new Error("Maintenance completed before native preparation");
              }),
            ]),
            signal,
          );
          expect(nativeClosed).toBe(false);
          await fs.rename(database.path, heldPath);
          originalMoved = true;
          await fs.rename(replacementPath, database.path);
          replacementInstalled = true;
          continuePreparation.resolve();
          const result = await racePromiseWithAbortSignal(outcome, signal);
          if (result.kind !== "failed") {
            throw new Error("Prepared maintenance accepted a replacement database");
          }
          const originalError =
            result.error instanceof AggregateError ? result.error.cause : result.error;
          expect(originalError).toMatchObject({
            message: "SQLite database file identity changed before existing-only open",
          });
          expect(result.nativeClosed).toBe(true);
          expect(await fs.readFile(database.path)).toEqual(successorBytes);
          expect(sql.queries).toEqual([]);
        } finally {
          continuePreparation.resolve();
          await outcome;
          try {
            // Join the real handle even on the unfixed path before restoring its original file.
            await closeNative?.();
          } finally {
            sql.restore();
            try {
              if (replacementInstalled) {
                await fs.rename(database.path, replacementPath);
              }
            } finally {
              if (originalMoved) {
                await fs.rename(heldPath, database.path);
              }
            }
          }
        }
        expect(loadSessionEntry(stale)).toMatchObject({ sessionId: "stale" });
        expect(loadSessionEntry(stale)?.archivedAt).toBeUndefined();
        await expect(
          runSqliteSessionReclamation({ forceInProcess: false, plan }),
        ).resolves.toMatchObject({
          kind: "maintenance-plan",
          value: { archivedEntries },
        });
        expect(
          loadSessionEntry({ sessionKey: stale.sessionKey, storePath: successorPath }),
        ).toMatchObject({
          sessionId: "successor",
          label: "successor untouched",
        });
      });
    },
  );

  it("preserves committed maintenance after joined preparation-discard failure", async ({
    signal,
  }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { stale, plan, archivedEntries } = maintenancePreparationFixture(state);
      const nativeClosed = createDeferredCore();
      const continueClose = createDeferredCore();
      const published = vi.fn();
      let committed = false;
      let settled = false;
      let closeNative: (() => Promise<void>) | undefined;
      const cleanupFailure = new Error("Preparation discard failed after committed maintenance");
      observeSessionMaintenancePlanningWorker({
        afterPrepare(_id, native) {
          const close = native.store.close.bind(native.store);
          closeNative = close;
          vi.spyOn(native.store, "close").mockImplementation(async () => {
            await close();
            nativeClosed.resolve();
            await continueClose.promise;
          });
        },
        afterExecute(result) {
          expect(result.kind).toBe("committed");
          committed = true;
        },
        beforeRelease() {
          expect(committed).toBe(true);
          throw cleanupFailure;
        },
      });
      const sql = observeHostDataSql();
      const pending = runSqliteSessionReclamation({
        forceInProcess: false,
        plan,
        onWorkerResult: published,
      });
      void pending
        .finally(() => {
          settled = true;
        })
        .catch(() => {});
      try {
        await racePromiseWithAbortSignal(
          Promise.race([
            nativeClosed.promise,
            pending.then(() => {
              throw new Error("Maintenance acknowledged before joining its native retirement");
            }),
          ]),
          signal,
        );
        expect(published).toHaveBeenCalledOnce();
        expect(settled).toBe(false);
        continueClose.resolve();
        await expect(pending).resolves.toMatchObject({
          kind: "maintenance-plan",
          value: { archived: 1, archivedEntries },
        });
        expect(sql.queries).toEqual([]);
      } finally {
        continueClose.resolve();
        await Promise.allSettled([pending]);
        try {
          await closeNative?.();
        } finally {
          sql.restore();
        }
      }
      expect(loadSessionEntry(stale)?.archivedAt).toEqual(expect.any(Number));
    });
  });
}
