import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { onTestFinished, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import type {
  SqliteWorkerOperations,
  SqliteWorkerStore,
} from "../../infra/sqlite-worker-contract.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import * as workerStore from "../../infra/sqlite-worker-store.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { createOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";
import * as databaseMaintenance from "../../state/openclaw-state-db-async-lifecycle.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import type { SqliteSessionReclamationPlan } from "./session-accessor.sqlite-lifecycle-types.js";
import { SESSION_ENTRY_MAINTENANCE_INTERVAL_MS } from "./session-accessor.sqlite-maintenance-age.js";
import * as maintenanceKick from "./session-accessor.sqlite-maintenance-kick.js";
import * as reclamationRun from "./session-accessor.sqlite-reclamation-run.js";
import { resolveSessionReclamationDatabaseOptions } from "./session-accessor.sqlite-reclamation.js";
import {
  resolveMaintenanceConfigFromInput,
  type ResolvedSessionMaintenanceConfig,
} from "./store-maintenance.js";

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
              const observer = hooks.beforeAdmission
                ? probe.admission(admission, (request, grant, callback) => {
                    hooks.beforeAdmission?.(request);
                    return callback(request, grant);
                  })
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

export function observeNextPeriodicMaintenance(
  delayMs: number | ((delay: number) => boolean) = SESSION_ENTRY_MAINTENANCE_INTERVAL_MS,
) {
  // Install after createStore opens the handles and registers their WAL timers.
  const scheduled = createDeferred();
  const setTimer = globalThis.setTimeout;
  const observer = vi.spyOn(globalThis, "setTimeout").mockImplementation((...args) => {
    const timer = setTimer(...args);
    if (
      typeof args[1] === "number" &&
      (typeof delayMs === "number" ? args[1] === delayMs : delayMs(args[1]))
    ) {
      scheduled.resolve();
    }
    return timer;
  });
  return (signal: AbortSignal) =>
    withinTest(scheduled.promise, signal).finally(() => observer.mockRestore());
}

export function countPlanningPasses() {
  return new Set(
    vi
      .mocked(reclamationRun.runSqliteSessionReclamation)
      .mock.calls.map(([{ plan }]) => plan)
      .filter((plan) => plan.kind === "maintenance-plan"),
  ).size;
}

export function createSessionMaintenanceKickStore(fixture: {
  storePath: string;
  key: string;
  pruneAfterMs: number;
  workerMaintenance: boolean;
  maintenanceScopes: Array<ReturnType<typeof createOpenClawDatabaseMaintenanceScope>>;
}) {
  const { storePath, key, pruneAfterMs, workerMaintenance, maintenanceScopes } = fixture;
  // Policy tests keep the fake clock in the native maintenance owner's process.
  const maintenance = workerMaintenance
    ? undefined
    : createOpenClawDatabaseMaintenanceScope({
        schemaMaintenance: true,
        assertOwnerCurrent() {},
        assertDatabaseAccess() {},
      });
  if (maintenance) {
    maintenanceScopes.push(maintenance);
    const kick = maintenanceKick.kickSessionEntryMaintenanceAfterWrite;
    vi.spyOn(maintenanceKick, "kickSessionEntryMaintenanceAfterWrite").mockImplementation(
      (request) => maintenance.run(() => kick(request)),
    );
    const captureResource = databaseMaintenance.captureOpenClawDatabaseMaintenanceResource;
    vi.spyOn(databaseMaintenance, "captureOpenClawDatabaseMaintenanceResource").mockImplementation(
      (resource, scope) => {
        const captured = captureResource(resource, scope);
        // Keep the scheduling owner and its callbacks on the same fake-clock execution path.
        return scope === maintenance
          ? { ...captured, runWorker: <T>(operation: () => Promise<T>) => captured.run(operation) }
          : captured;
      },
    );
  }
  const runReclamation = reclamationRun.runSqliteSessionReclamation;
  const archived = createDeferred();
  const planned = createDeferred();
  vi.spyOn(reclamationRun, "runSqliteSessionReclamation").mockImplementation((params) => {
    const result = runReclamation(params);
    // Observe publication without consuming the fault probes' original rejections.
    void result.then(
      (value) => {
        if (value.kind === "maintenance-plan") {
          planned.resolve();
          if (value.value.archived > 0) {
            archived.resolve();
          }
        }
      },
      () => {},
    );
    return result;
  });
  const scope = { agentId: "main", path: storePath };
  const database = openOpenClawAgentDatabase(scope);
  const updatedAt = Date.now();
  runOpenClawAgentWriteTransaction((owner) => {
    writeSessionEntry(owner, key, { sessionId: "age-kick", updatedAt });
  }, scope);
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(updatedAt);
  const maintenanceConfig: ResolvedSessionMaintenanceConfig = {
    ...resolveMaintenanceConfigFromInput(),
    archiveDashboardAfterMs: null,
    preserveRecentMs: null,
    pruneAfterMs,
  };
  const request = {
    activeSessionKey: key,
    archiveDirectory: path.join(path.dirname(storePath), "archives"),
    maintenanceConfig,
    scope,
    storePath,
  };
  return {
    database,
    request,
    scope,
    storePath,
    updatedAt,
    archived: archived.promise,
    planned: planned.promise,
  };
}
