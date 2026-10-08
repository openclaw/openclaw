import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { onTestFinished, vi } from "vitest";
import type {
  SqliteWorkerOperations,
  SqliteWorkerStore,
} from "../../infra/sqlite-worker-contract.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
import * as workerStore from "../../infra/sqlite-worker-store.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.js";
import type { SqliteSessionReclamationPlan } from "./session-accessor.sqlite-lifecycle-types.js";
import { resolveSessionReclamationDatabaseOptions } from "./session-accessor.sqlite-reclamation.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";

type SessionMaintenancePlanningWorkerResponse = {
  kind: "committed" | "not-committed" | "read-only";
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
                const reading =
                  command.type === "session.maintenance.read" &&
                  isRecord(command.input) &&
                  command.input.kind === "maintenance-plan";
                if (planning || reading) {
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
                  reading &&
                  isRecord(result) &&
                  isRecord(result.result) &&
                  result.result.kind === "maintenance-plan"
                ) {
                  if (typeof result.workerThreadId !== "number") {
                    throw new Error("Real maintenance read omitted its worker identity");
                  }
                  await hooks.afterExecute?.(
                    { kind: "read-only", workerThreadId: result.workerThreadId },
                    {},
                  );
                }
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
        );
      },
    );
}

export function maintenancePreparationFixture(state: OpenClawTestState) {
  const storePath = path.join(state.sessionsDir(), "sessions.json");
  const active = { sessionKey: "agent:main:preparation-active", storePath };
  const stale = { sessionKey: "agent:main:preparation-stale", storePath };
  replaceSessionEntrySync(active, { sessionId: "active", updatedAt: Date.now() });
  replaceSessionEntrySync(stale, { sessionId: "stale", updatedAt: 1 });
  const databaseOptions = { agentId: "main", env: state.env };
  const database = openOpenClawAgentDatabase(databaseOptions);
  const plan = {
    kind: "maintenance-plan",
    databaseOptions: resolveSessionReclamationDatabaseOptions(databaseOptions),
    materializedPlans: [],
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
  } satisfies SqliteSessionReclamationPlan;
  const archivedEntries = [{ sessionKey: stale.sessionKey, sessionId: "stale" }];
  return { active, stale, database, plan, archivedEntries };
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
