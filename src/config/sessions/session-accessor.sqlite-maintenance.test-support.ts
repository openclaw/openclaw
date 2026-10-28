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

export function observeSessionMaintenancePlanningWorker(hooks: {
  beforeExecute?: () => void;
  beforeAdmission?: (request: admission.SqliteWorkerAdmissionRequest) => void;
  afterPrepare?: (native: {
    store: Pick<SqliteWorkerStore<SqliteWorkerOperations>, "close">;
  }) => void | Promise<void>;
  afterExecute?: (
    result: { kind: "committed" | "not-committed"; workerThreadId: number },
    native: {
      admission?: admission.SqliteWorkerOperationAdmission;
      retained?: RetainedWorkerTransactionAdmission;
    },
  ) => void | Promise<void>;
}) {
  const original = workerStore.runSqliteWorkerStoreOperation;
  const observe: typeof original = (target, operation, ...context) => {
    const [stateContext, assertCurrent, createAdmission] = context;
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
            const result = await worker.execute(command, options);
            if (command.type === "session.maintenance.prepare") {
              await hooks.afterPrepare?.({ store: target });
            }
            if (
              planning ||
              (command.type === "session.maintenance.prepare" && result !== undefined)
            ) {
              if (
                !isRecord(result) ||
                typeof result.workerThreadId !== "number" ||
                (result.kind !== "committed" && result.kind !== "not-committed")
              ) {
                throw new Error("Real maintenance omitted its native identity or outcome");
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
  };
  return vi.spyOn(workerStore, "runSqliteWorkerStoreOperation").mockImplementation(observe);
}

export function maintenancePolicy(
  pruneAfter = "1s",
  overrides: Parameters<typeof resolveMaintenanceConfigFromInput>[0] = {},
) {
  return resolveMaintenanceConfigFromInput({
    mode: "enforce",
    maxEntries: 100,
    pruneAfter,
    ...overrides,
  });
}

export function maintenanceFixture(state: OpenClawTestState) {
  const storePath = path.join(state.sessionsDir(), "sessions.json");
  const scope = (sessionKey: string) => ({ sessionKey, storePath });
  const seed = (
    sessionKey: string,
    sessionId: string,
    updatedAt = Date.now(),
    fields: Partial<Parameters<typeof replaceSessionEntrySync>[1]> = {},
  ) => {
    const target = scope(sessionKey);
    replaceSessionEntrySync(target, { sessionId, updatedAt, ...fields });
    return target;
  };
  const databaseOptions = { agentId: "main", env: state.env };
  const plan = (activeSessionKey: string, maintenance = maintenancePolicy("1d")) =>
    ({
      kind: "maintenance-plan",
      databaseOptions: resolveSessionReclamationDatabaseOptions(databaseOptions),
      materializedPlans: [],
      input: {
        activeSessionKey,
        archiveDirectory: state.sessionsDir(),
        maintenance,
        preservation: { providerKeys: [], workIdentities: [], lifecycleIdentities: [] },
        storePath,
      },
    }) satisfies SqliteSessionReclamationPlan;
  return { state, storePath, scope, seed, databaseOptions, plan };
}

export function maintenancePreparationFixture(state: OpenClawTestState) {
  const fixture = maintenanceFixture(state);
  const active = fixture.seed("agent:main:preparation-active", "active");
  const stale = fixture.seed("agent:main:preparation-stale", "stale", 1);
  const database = openOpenClawAgentDatabase(fixture.databaseOptions);
  const archivedEntries = [{ sessionKey: stale.sessionKey, sessionId: "stale" }];
  return { active, stale, database, plan: fixture.plan(active.sessionKey), archivedEntries };
}

/** Observe committed maintenance rows without imposing a worker-startup deadline. */
export function observeSessionMaintenanceChanges(databasePath: string, ...sessionKeys: string[]) {
  const pending = new Set(sessionKeys);
  const completed = createDeferred();
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
  const plans = vi
    .mocked(reclamationRun.runSqliteSessionReclamation)
    .mock.calls.map(([{ plan }]) => plan);
  return new Set(plans.filter((plan) => plan.kind === "maintenance-plan")).size;
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
  return {
    database,
    request: {
      activeSessionKey: key,
      archiveDirectory: path.join(path.dirname(storePath), "archives"),
      maintenanceConfig,
      scope,
      storePath,
    },
    scope,
    storePath,
    updatedAt,
    archived: archived.promise,
    planned: planned.promise,
  };
}
