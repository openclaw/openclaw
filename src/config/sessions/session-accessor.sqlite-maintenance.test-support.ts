import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import type {
  SqliteWorkerOperations,
  SqliteWorkerStore,
} from "../../infra/sqlite-worker-contract.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
import * as workerStore from "../../infra/sqlite-worker-store.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { loadSessionEntry, replaceSessionEntrySync } from "./session-accessor.js";
import * as maintenance from "./session-accessor.sqlite-maintenance.js";
import {
  createSessionMaintenancePlanningOperation,
  runSqliteSessionReclamation,
} from "./session-accessor.sqlite-reclamation.js";
import { applySessionEntryExactReplacements } from "./session-accessor.sqlite-replacement-projection.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";

type SessionMaintenancePlanningWorkerResponse = {
  kind: "committed" | "not-committed";
  workerThreadId: number;
};

export function observeSessionMaintenancePlanningWorker(hooks: {
  beforeExecute?: () => void;
  beforeAdmission?: (request: admission.SqliteWorkerAdmissionRequest) => void;
  afterPrepare?: (
    id: string,
    native: { store: Pick<SqliteWorkerStore<SqliteWorkerOperations>, "close"> },
  ) => void | Promise<void>;
  beforeRelease?: (id: string) => void | Promise<void>;
  afterRelease?: (id: string) => void | Promise<void>;
  afterExecute?: (
    result: SessionMaintenancePlanningWorkerResponse,
    native: {
      admission?: admission.SqliteWorkerOperationAdmission;
      retained?: RetainedWorkerTransactionAdmission;
    },
  ) => void | Promise<void>;
}) {
  const original = workerStore.runSqliteWorkerStoreOperation;
  return vi
    .spyOn(workerStore, "runSqliteWorkerStoreOperation")
    .mockImplementation(
      <Operations extends SqliteWorkerOperations, T>(
        target: SqliteWorkerStore<Operations>,
        operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
        stateContext?: Parameters<typeof original>[2],
        assertCurrent?: Parameters<typeof original>[3],
        createAdmission?: Parameters<typeof original>[4],
        requireStateLifecycle?: Parameters<typeof original>[5],
      ) => {
        let planning = false;
        let nativeAdmission: admission.SqliteWorkerOperationAdmission | undefined;
        let nativeRetention: RetainedWorkerTransactionAdmission | undefined;
        return original(
          target,
          (worker) =>
            operation({
              execute: async (command, options) => {
                planning =
                  command.type === "session.maintenance.metadata" &&
                  isRecord(command.input) &&
                  command.input.kind === "maintenance-plan";
                if (planning) {
                  hooks.beforeExecute?.();
                }
                const preparationCommand =
                  command.type === "session.maintenance.prepare" ||
                  command.type === "session.maintenance.release";
                const preparationId =
                  preparationCommand &&
                  isRecord(command.input) &&
                  typeof command.input.id === "string"
                    ? command.input.id
                    : undefined;
                if (preparationCommand && preparationId === undefined) {
                  throw new Error("Real maintenance preparation omitted its private identity");
                }
                if (
                  command.type === "session.maintenance.release" &&
                  preparationId !== undefined &&
                  hooks.beforeRelease
                ) {
                  await hooks.beforeRelease(preparationId);
                }
                const result = await worker.execute(command, options);
                if (
                  command.type === "session.maintenance.prepare" &&
                  preparationId !== undefined &&
                  hooks.afterPrepare
                ) {
                  await hooks.afterPrepare(preparationId, { store: target });
                } else if (
                  command.type === "session.maintenance.release" &&
                  preparationId !== undefined &&
                  hooks.afterRelease
                ) {
                  await hooks.afterRelease(preparationId);
                }
                if (planning) {
                  if (!isRecord(result) || typeof result.workerThreadId !== "number") {
                    throw new Error("Real maintenance omitted its native worker identity");
                  }
                  if (result.kind !== "committed" && result.kind !== "not-committed") {
                    throw new Error("Real maintenance omitted its native outcome");
                  }
                  await hooks.afterExecute?.(
                    { kind: result.kind, workerThreadId: result.workerThreadId },
                    { admission: nativeAdmission, retained: nativeRetention },
                  );
                }
                return result;
              },
            }),
          stateContext,
          assertCurrent,
          createAdmission &&
            ((retained) => {
              if (!planning) {
                return createAdmission(retained);
              }
              const authorize = admission.createSqliteWorkerOperationAdmission;
              const observer = hooks.beforeAdmission
                ? vi
                    .spyOn(admission, "createSqliteWorkerOperationAdmission")
                    .mockImplementation((callback, attachment) =>
                      authorize((request, grant) => {
                        hooks.beforeAdmission?.(request);
                        return callback(request, grant);
                      }, attachment),
                    )
                : undefined;
              try {
                const owned = createAdmission(retained);
                nativeRetention = retained;
                nativeAdmission = owned.admission;
                return owned;
              } finally {
                observer?.mockRestore();
              }
            }),
          requireStateLifecycle,
        );
      },
    );
}

function maintenancePreparationFixture(state: OpenClawTestState) {
  const storePath = path.join(state.sessionsDir(), "sessions.json");
  const active = { sessionKey: "agent:main:preparation-active", storePath };
  const stale = { sessionKey: "agent:main:preparation-stale", storePath };
  replaceSessionEntrySync(active, { sessionId: "active", updatedAt: Date.now() });
  replaceSessionEntrySync(stale, { sessionId: "stale", updatedAt: 1 });
  const databaseOptions = { agentId: "main", env: state.env };
  const database = openOpenClawAgentDatabase(databaseOptions);
  const plan = createSessionMaintenancePlanningOperation({
    databaseOptions,
    input: {
      activeSessionKey: active.sessionKey,
      archiveDirectory: state.sessionsDir(),
      maintenance: resolveMaintenanceConfigFromInput({
        mode: "enforce",
        maxEntries: 100,
        pruneAfter: "1d",
      }),
      preservation: { providerKeys: [], workIdentities: [], lifecycleIdentities: [] },
      storePath,
    },
  });
  return { active, stale, database, plan };
}

export function registerSessionMaintenancePreparationTests() {
  it("lets foreground writes invalidate prepared maintenance without caller-thread data SQL", async ({
    signal,
  }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { active, stale, database, plan } = maintenancePreparationFixture(state);
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
      const sql = observeHostDataSql(state.env);
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
          sessionKeys: [active.sessionKey],
          skipMaintenance: true,
          update: ([row]) => ({
            result: undefined,
            replacements: [
              {
                sessionKey: active.sessionKey,
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
        expect(published).toEqual([]);
        continuePreparation.resolve();
        await expect(pending).resolves.toEqual({ kind: "maintenance-plan-stale" });
        expect(released).toEqual([preparations[0]]);
        expect(published).toEqual([]);
        retry = runSqliteSessionReclamation({ forceInProcess: false, plan });
        await expect(retry).resolves.toMatchObject({
          kind: "maintenance-plan",
          value: { archived: 1, archivedSessionKeys: [stale.sessionKey], entryRemovals: [] },
        });
        expect(preparations).toHaveLength(2);
        expect(preparations[0]).not.toBe(preparations[1]);
        expect(released).toEqual(preparations);
        expect(published).toEqual([stale.sessionKey]);
        expect(sql.queries).toEqual([]);
      } finally {
        continuePreparation.resolve();
        await Promise.allSettled([pending, foreground, retry]);
        sql.restore();
        unsubscribe();
      }
      expect(loadSessionEntry(active)?.label).toBe("foreground progressed");
      expect(loadSessionEntry(stale)?.archivedAt).toEqual(expect.any(Number));
    });
  });

  it.each(["caller revocation", "lost preparation reply"] as const)(
    "joins preparation cleanup after %s without discarding another caller's preparation",
    async (failure, { signal }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const { stale, plan } = maintenancePreparationFixture(state);
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
        const sql = observeHostDataSql(state.env);
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
            value: { archived: 1, archivedSessionKeys: [stale.sessionKey] },
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
        const { stale, database, plan } = maintenancePreparationFixture(state);
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
        const sql = observeHostDataSql(state.env);
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
          value: { archivedSessionKeys: [stale.sessionKey] },
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
      const { stale, plan } = maintenancePreparationFixture(state);
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
      const sql = observeHostDataSql(state.env);
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
          value: { archived: 1, archivedSessionKeys: [stale.sessionKey] },
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

/** Row changes precede archive publication; join the owner's complete finalization. */
export function observeSessionMaintenanceCompletion(databasePath: string) {
  const finalize = maintenance.finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort;
  const completed = createDeferredCore<Awaited<ReturnType<typeof finalize>>>();
  const observer = vi
    .spyOn(maintenance, "finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort")
    .mockImplementation((scope, ...args) => {
      const result = finalize(scope, ...args);
      if (scope.path === databasePath) {
        completed.resolve(result);
      }
      return result;
    });
  onTestFinished(() => observer.mockRestore());
  return completed.promise;
}

/** Observe committed maintenance rows without imposing a worker-startup deadline. */
export function observeSessionMaintenanceChanges(databasePath: string, ...sessionKeys: string[]) {
  const pending = new Set(sessionKeys);
  const completed = createDeferredCore();
  const unsubscribe = sessionChanges.subscribe((change) => {
    if (!("sessionKey" in change) || change.storePath !== databasePath) {
      return;
    }
    if (pending.delete(change.sessionKey) && pending.size === 0) {
      unsubscribe();
      completed.resolve();
    }
  });
  onTestFinished(unsubscribe);
  return completed.promise;
}
