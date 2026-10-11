import { isDeepStrictEqual } from "node:util";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../../infra/sqlite-worker-identity.js";
import { getChildLogger } from "../../logging/logger.js";
import {
  GatewayDrainingError,
  getGatewayRestartDrainSignal,
  isGatewayRestartDrainError,
} from "../../process/gateway-work-admission.js";
import { runInDetachedAsyncContext } from "../../shared/detached-async-context.js";
import { captureAgentDatabaseAdmission } from "../../state/agent-database-admission.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import type { OpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution-contract.js";
import {
  captureOpenClawAgentDatabaseExecution,
  supportsOpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution.js";
import {
  captureOpenClawDatabaseMaintenanceResource,
  getOpenClawDatabaseMaintenanceScope,
} from "../../state/openclaw-state-db-async-lifecycle.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import type { SqliteSessionReclamationPlan } from "./session-accessor.sqlite-lifecycle-types.js";
import {
  SESSION_ENTRY_MAINTENANCE_INTERVAL_MS,
  isMonotoneSessionEntryMaintenanceAgeChange,
  observeSessionEntryMaintenanceAgeChanges,
  type SessionEntryMaintenanceAgeChange,
} from "./session-accessor.sqlite-maintenance-age.js";
import { finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort } from "./session-accessor.sqlite-maintenance.js";
import { runSqliteSessionReclamation } from "./session-accessor.sqlite-reclamation-run.js";
import { SqliteReclamationInputsChangedError } from "./session-accessor.sqlite-reclamation-worker-diagnostics.js";
import { resolveSessionReclamationDatabaseOptions } from "./session-accessor.sqlite-reclamation.js";
import {
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  type ResolvedSqliteReadScope,
} from "./session-accessor.sqlite-scope.js";
import { prepareSessionMaintenancePreservation } from "./store-maintenance-preserve.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import {
  normalizeResolvedMaintenanceConfigInput,
  type ResolvedSessionMaintenanceConfig,
  type ResolvedSessionMaintenanceConfigInput,
} from "./store-maintenance.js";

type SessionEntryMaintenanceRequest = {
  activeSessionKey: string;
  archiveDirectory: string;
  maintenanceConfig?: ResolvedSessionMaintenanceConfigInput;
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "databaseAgentId" | "env" | "path">;
  skipMaintenance?: boolean;
  storePath: string;
};
type SessionEntryMaintenanceOwner = SessionEntryMaintenanceRequest & {
  activeSessionKeys: Set<string>;
  ageChanges: Map<string, SessionEntryMaintenanceAgeChange>;
  assertCurrent: () => void;
  captureExecution: () => OpenClawAgentDatabaseExecution | undefined;
  maintenanceResource?: ReturnType<typeof captureOpenClawDatabaseMaintenanceResource>;
  execution?: OpenClawAgentDatabaseExecution;
  active?: Promise<void>;
  release?: Promise<void>;
  retirement?: Promise<void>;
  generation: number;
  running: boolean;
  completedMaintenanceConfig?: ResolvedSessionMaintenanceConfig;
  rejections: number;
  retryDelayMs?: number;
  immediate?: ReturnType<typeof setImmediate>;
  timer?: ReturnType<typeof setTimeout>;
  timerDeadlineMonotonicMs?: number;
  timerKind?: "periodic" | "write-batch" | "retry";
  unregisterClose?: () => void;
};

const maintenanceByStore = new Map<string, SessionEntryMaintenanceOwner>();
const MAINTENANCE_WRITE_QUIET_MS = 1_000;
const MAX_MAINTENANCE_REJECTIONS = 3;

/** Coalesce automatic logical maintenance outside ordinary entry-write latency. */
export function kickSessionEntryMaintenanceAfterWrite(
  params: SessionEntryMaintenanceRequest,
): void {
  const databasePath = resolveOpenClawAgentSqlitePath(toDatabaseOptions(params.scope));
  const owner = maintenanceByStore.get(databasePath);
  if (getGatewayRestartDrainSignal().aborted) {
    if (owner) {
      retireMaintenanceOwner(databasePath, owner);
    }
    return;
  }
  if (params.skipMaintenance) {
    return;
  }
  if (owner && isMaintenanceOwnerCurrent(databasePath, owner)) {
    owner.activeSessionKeys.add(params.activeSessionKey);
    Object.assign(owner, params, { scope: owner.scope, generation: owner.generation + 1 });
    const canBatch = () =>
      owner.ageChanges.size > 0 &&
      [...owner.ageChanges.values()].every(isMonotoneSessionEntryMaintenanceAgeChange) &&
      isDeepStrictEqual(
        owner.completedMaintenanceConfig,
        owner.maintenanceConfig
          ? normalizeResolvedMaintenanceConfigInput(owner.maintenanceConfig)
          : resolveMaintenanceConfig(),
      );
    if (owner.timerKind === "write-batch" && !canBatch()) {
      scheduleImmediateMaintenance(databasePath, owner);
      return;
    }
    if (!owner.running) {
      if (owner.retryDelayMs !== undefined) {
        if (owner.rejections >= MAX_MAINTENANCE_REJECTIONS) {
          owner.rejections = 0;
        }
        scheduleMaintenanceAfterWriteQuiet(databasePath, owner);
      } else if (canBatch()) {
        scheduleMaintenanceWriteBatch(databasePath, owner);
      } else {
        scheduleImmediateMaintenance(databasePath, owner);
      }
    }
    return;
  }
  if (owner) {
    retireMaintenanceOwner(databasePath, owner);
  }
  const env = cloneEnvWithPlatformSemantics(params.scope.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const scope = { ...params.scope, env, path: databasePath };
  const options = toDatabaseOptions(scope);
  const assertAdmitted = captureAgentDatabaseAdmission(options.agentId, { env });
  const identity = isIncognitoOpenClawAgentSqlitePath(databasePath, options)
    ? undefined
    : readDatabasePathIdentitySync(databasePath);
  if (identity && !identity.key.startsWith("file:")) {
    return;
  }
  const captureExecution = () =>
    supportsOpenClawAgentDatabaseExecution(options) && identity
      ? captureOpenClawAgentDatabaseExecution(options, {
          expectedIdentity: {
            kind: "file",
            physicalIdentity: identity.key.slice(5),
            birthtime: identity.birthtime,
            nativeLocation: identity.canonicalPath,
          },
        })
      : undefined;
  const created: SessionEntryMaintenanceOwner = {
    ...params,
    scope,
    activeSessionKeys: new Set([params.activeSessionKey]),
    ageChanges: new Map(),
    captureExecution,
    execution: captureExecution(),
    assertCurrent: () => {
      assertAdmitted();
      created.execution?.assertCurrent();
      if (identity) {
        assertExistingDatabaseIdentity(databasePath, identity.key, identity.birthtime);
      }
    },
    generation: 1,
    running: false,
    rejections: 0,
  };
  maintenanceByStore.set(databasePath, created);
  const maintenanceScope = getOpenClawDatabaseMaintenanceScope();
  const unregister: Array<() => void> = [];
  created.unregisterClose = () => unregister.forEach((release) => release());
  try {
    if (identity) {
      unregister.push(
        observeSessionEntryMaintenanceAgeChanges(identity.key.slice(5), (change) => {
          const previous = created.ageChanges.get(change.sessionKey);
          created.ageChanges.set(change.sessionKey, {
            ...change,
            previousEntry: previous ? previous.previousEntry : change.previousEntry,
          });
        }),
      );
    }
    for (const resourcePath of new Set([databasePath, identity?.canonicalPath ?? databasePath])) {
      const unregisterResource = registerOpenClawAgentDatabaseAsyncResource({
        agentId: options.agentId,
        path: resourcePath,
        revoke: () => retireMaintenanceOwner(databasePath, created),
        close: async () => {
          retireMaintenanceOwner(databasePath, created);
          await created.retirement;
        },
      });
      unregister.push(unregisterResource);
      if (maintenanceScope) {
        created.maintenanceResource ??= captureOpenClawDatabaseMaintenanceResource(
          unregisterResource,
          maintenanceScope,
        );
      }
    }
  } catch (error) {
    retireMaintenanceOwner(databasePath, created);
    throw error;
  }
  scheduleImmediateMaintenance(databasePath, created);
}

function isMaintenanceOwnerCurrent(
  databasePath: string,
  owner: SessionEntryMaintenanceOwner,
): boolean {
  if (getGatewayRestartDrainSignal().aborted || maintenanceByStore.get(databasePath) !== owner) {
    return false;
  }
  try {
    owner.maintenanceResource?.assertCurrent();
    owner.assertCurrent();
    return true;
  } catch {
    // Retired admission or a replaced pathname cannot authorize discretionary maintenance.
    return false;
  }
}

function retireMaintenanceOwner(databasePath: string, owner: SessionEntryMaintenanceOwner): void {
  if (owner.retirement) {
    return;
  }
  clearImmediate(owner.immediate);
  clearTimeout(owner.timer);
  if (maintenanceByStore.get(databasePath) === owner) {
    maintenanceByStore.delete(databasePath);
  }
  releaseMaintenanceExecution(databasePath, owner);
  // Keep close custody through finalization, including gaps between Worker requests.
  owner.retirement = (async () => {
    await owner.active;
    await owner.release;
    owner.unregisterClose?.();
  })();
  void owner.retirement.catch((error: unknown) =>
    getChildLogger({ subsystem: "session-sqlite" }).warn(
      "SQLite automatic maintenance could not retire",
      { error, path: databasePath },
    ),
  );
}

function releaseMaintenanceExecution(
  databasePath: string,
  owner: SessionEntryMaintenanceOwner,
): void {
  if (!owner.execution) {
    return;
  }
  const released = owner.execution.release();
  owner.release = owner.release
    ? Promise.all([owner.release, released]).then(() => undefined)
    : released;
  owner.execution = undefined;
  void owner.release.catch((error: unknown) =>
    getChildLogger({ subsystem: "session-sqlite" }).warn(
      "SQLite automatic maintenance could not release its executor",
      { error, path: databasePath },
    ),
  );
}

function capturePendingAgeChanges(owner: SessionEntryMaintenanceOwner) {
  const changes = [...owner.ageChanges.values()];
  return {
    changes,
    acknowledge() {
      for (const change of changes) {
        if (owner.ageChanges.get(change.sessionKey) === change) {
          owner.ageChanges.delete(change.sessionKey);
        }
      }
    },
  };
}

function scheduleImmediateMaintenance(
  databasePath: string,
  owner: SessionEntryMaintenanceOwner,
): void {
  clearTimeout(owner.timer);
  owner.timer = undefined;
  owner.timerDeadlineMonotonicMs = undefined;
  owner.timerKind = undefined;
  owner.running = true;
  // Database maintenance outlives the writer's turn and carries its own admission.
  owner.immediate = runInDetachedAsyncContext(() =>
    setImmediate(() => {
      owner.immediate = undefined;
      startPendingMaintenance(databasePath, owner);
    }),
  );
}

function scheduleMaintenanceWriteBatch(
  databasePath: string,
  owner: SessionEntryMaintenanceOwner,
): void {
  const now = performance.now();
  const delayMs = Math.max(
    1,
    Math.min(
      MAINTENANCE_WRITE_QUIET_MS,
      Math.ceil((owner.timerDeadlineMonotonicMs ?? Infinity) - now),
    ),
  );
  clearTimeout(owner.timer);
  // Further kicks join this bounded batch; they cannot refresh or postpone its deadline.
  owner.running = true;
  owner.timerKind = "write-batch";
  owner.timerDeadlineMonotonicMs = now + delayMs;
  owner.timer = runInDetachedAsyncContext(() =>
    setTimeout(() => startPendingMaintenance(databasePath, owner), delayMs),
  );
  owner.timer.unref();
}

function scheduleMaintenanceAfterWriteQuiet(
  databasePath: string,
  owner: SessionEntryMaintenanceOwner,
): void {
  owner.running = false;
  owner.retryDelayMs = MAINTENANCE_WRITE_QUIET_MS * 2 ** Math.max(0, owner.rejections - 1);
  owner.timerDeadlineMonotonicMs = performance.now() + owner.retryDelayMs;
  owner.timerKind = "retry";
  if (owner.timer) {
    // A write restarts this one-shot quiet window; no polling or competing retry owner.
    owner.timer.refresh();
    return;
  }
  owner.timer = runInDetachedAsyncContext(() =>
    setTimeout(() => {
      owner.timer = undefined;
      owner.retryDelayMs = undefined;
      owner.running = true;
      startPendingMaintenance(databasePath, owner);
    }, owner.retryDelayMs),
  );
  owner.timer.unref();
}

function startPendingMaintenance(databasePath: string, owner: SessionEntryMaintenanceOwner): void {
  owner.timer = undefined;
  owner.timerDeadlineMonotonicMs = undefined;
  owner.timerKind = undefined;
  // Publish the join before a pass can synchronously retire itself.
  owner.active = Promise.resolve().then(async () => {
    if (!isMaintenanceOwnerCurrent(databasePath, owner)) {
      retireMaintenanceOwner(databasePath, owner);
      return;
    }
    // Detach turn context, but keep Doctor/temporary-command database custody
    // so background borrowing cannot move handles outside their cleanup scope.
    const run = () => runPendingMaintenance(databasePath, owner);
    await (owner.maintenanceResource ? owner.maintenanceResource.run(run) : run());
  });
}

async function runPendingMaintenance(
  databasePath: string,
  owner: SessionEntryMaintenanceOwner,
): Promise<void> {
  const isCurrent = () => isMaintenanceOwnerCurrent(databasePath, owner);
  if (!isCurrent()) {
    retireMaintenanceOwner(databasePath, owner);
    return;
  }
  const generation = owner.generation;
  let activeSessionKeys = [...owner.activeSessionKeys];
  owner.activeSessionKeys.clear();
  let nextMaintenanceAt: number | undefined = Infinity;
  let planningChanged = false;
  let finalized = false;
  let preservation: Awaited<ReturnType<typeof prepareSessionMaintenancePreservation>> | undefined;
  const capturePreservation = () => {
    try {
      return preservation?.capture() ?? null;
    } catch (error) {
      planningChanged = true;
      throw error;
    }
  };
  try {
    owner.execution ??= owner.captureExecution();
    const prepared = await runExclusiveSqliteSessionWrite(
      owner.scope,
      async () => {
        // The writer queue can outlive the handle that admitted this owner.
        // Check inside the acquired lane so an evicted owner cannot reopen the path.
        if (!isCurrent()) {
          return undefined;
        }
        const maintenance = owner.maintenanceConfig
          ? normalizeResolvedMaintenanceConfigInput(owner.maintenanceConfig)
          : resolveMaintenanceConfig();
        const operation: Extract<
          SqliteSessionReclamationPlan,
          { kind: "maintenance-plan" }
        > | null =
          maintenance.mode === "warn"
            ? null
            : {
                databaseOptions: resolveSessionReclamationDatabaseOptions(
                  toDatabaseOptions(owner.scope),
                ),
                kind: "maintenance-plan",
                materializedPlans: [],
                input: {
                  activeSessionKeys,
                  archiveDirectory: owner.archiveDirectory,
                  maintenance,
                  preservation: null,
                  storePath: owner.storePath,
                },
              };
        return { maintenance, operation };
      },
      "session.maintenance.plan",
    );
    if (!prepared) {
      retireMaintenanceOwner(databasePath, owner);
      return;
    }
    // A running pass keeps its captured policy; configuration changes apply to the next pass.
    const { maintenance, operation } = prepared;
    if (operation === null) {
      if (isCurrent() && owner.generation !== generation) {
        scheduleMaintenanceAfterWriteQuiet(databasePath, owner);
      } else {
        retireMaintenanceOwner(databasePath, owner);
      }
      return;
    }
    let admitted = false;
    const assertInputsCurrent = () => {
      if (!isCurrent()) {
        if (getGatewayRestartDrainSignal().aborted) {
          throw new GatewayDrainingError();
        }
        planningChanged = true;
        throw new SqliteReclamationInputsChangedError("SQLite automatic maintenance owner retired");
      }
      if (
        (admitted &&
          [...owner.activeSessionKeys].some((key) => !activeSessionKeys.includes(key))) ||
        (admitted &&
          operation.input.preservation !== null &&
          !isDeepStrictEqual(operation.input.preservation, capturePreservation()))
      ) {
        planningChanged = true;
        throw new SqliteReclamationInputsChangedError(
          "SQLite automatic maintenance inputs changed before commit",
        );
      }
    };
    const readOnlyPhase: { deadline?: { nextAt: number | undefined } } = {};
    const runPlanning = async () => {
      delete readOnlyPhase.deadline;
      const pending = capturePendingAgeChanges(owner);
      operation.ageChanges = pending.changes;
      const result = await runSqliteSessionReclamation({
        diagnostics: { kind: "maintenance-plan" },
        assertCommitAllowed: assertInputsCurrent,
        consumeReadOnlyMaintenancePlan(read, assertCurrent) {
          assertInputsCurrent();
          pending.acknowledge();
          if (owner.ageChanges.size > 0) {
            planningChanged = true;
            throw new SqliteReclamationInputsChangedError(
              "SQLite automatic maintenance activity changed before age consumption",
            );
          }
          assertCurrent();
          readOnlyPhase.deadline = { nextAt: read.nextAt };
        },
        refreshMaintenanceProtection: () => {
          // Refresh only at writer admission; commit still checks this exact live capture.
          admitted = false;
          assertInputsCurrent();
          activeSessionKeys = [...new Set([...activeSessionKeys, ...owner.activeSessionKeys])];
          operation.input.activeSessionKeys = activeSessionKeys;
          if (operation.input.preservation !== null) {
            operation.input.preservation = capturePreservation();
          }
          admitted = true;
          return { activeSessionKeys, preservation: operation.input.preservation };
        },
        forceInProcess: false,
        plan: operation,
      });
      if (result.kind === "maintenance-plan") {
        pending.acknowledge();
      }
      return result;
    };
    let result = await runPlanning();
    if (result.kind === "maintenance-preservation-required") {
      preservation = await prepareSessionMaintenancePreservation(operation.input.storePath);
      assertInputsCurrent();
      operation.input.preservation = capturePreservation();
      result = await runPlanning();
    }
    if (result.kind === "maintenance-plan-stale") {
      planningChanged = true;
      throw new SqliteReclamationInputsChangedError(
        "SQLite maintenance snapshot changed before commit",
      );
    }
    if (result.kind !== "maintenance-plan") {
      throw new Error("SQLite automatic maintenance returned another operation's result");
    }
    const plan = result.value;
    const readAge = async () => {
      assertInputsCurrent();
      const pending = capturePendingAgeChanges(owner);
      const age = await runSqliteSessionReclamation({
        diagnostics: { kind: "maintenance-age" },
        assertCommitAllowed: assertInputsCurrent,
        forceInProcess: false,
        plan: {
          kind: "maintenance-age",
          databaseOptions: operation.databaseOptions,
          materializedPlans: [],
          maintenance,
          ageChanges: pending.changes,
          readOnly: result.readOnlyInput ? { input: result.readOnlyInput } : undefined,
        },
      });
      if (age.kind === "maintenance-age" || age.kind === "maintenance-plan-stale") {
        pending.acknowledge();
      }
      if (age.kind === "maintenance-plan-stale") {
        planningChanged = true;
        throw new SqliteReclamationInputsChangedError(
          "SQLite automatic maintenance age fact changed after no-op planning",
        );
      }
      if (age.kind !== "maintenance-age") {
        throw new Error("SQLite automatic maintenance returned another age result");
      }
      return age.nextAt;
    };
    const noChanges = plan.archived === 0 && plan.entryRemovals.length === 0;
    const noFinalization = noChanges && plan.stateDeletePlans.length === 0;
    const verifiedNextAt = noChanges
      ? readOnlyPhase.deadline
        ? readOnlyPhase.deadline.nextAt
        : await readAge()
      : undefined;
    if (!noFinalization) {
      await finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort(owner.scope, [plan], {
        isCurrent,
      });
    }
    finalized = true;
    // A deadline-probe retry cannot restore a completed pass's write protection.
    activeSessionKeys = [];
    if (isCurrent() && owner.generation === generation) {
      assertInputsCurrent();
      // Reuse only this pass's consumed decision; newer kicks and changes win after settlement.
      nextMaintenanceAt = noFinalization ? verifiedNextAt : await readAge();
      if (owner.ageChanges.size > 0) {
        planningChanged = true;
        throw new SqliteReclamationInputsChangedError(
          "SQLite automatic maintenance activity changed during age publication",
        );
      }
    }
    owner.rejections = 0;
    owner.completedMaintenanceConfig = structuredClone(maintenance);
  } catch (error) {
    preservation?.dispose();
    if (planningChanged && isCurrent()) {
      if (finalized && owner.generation !== generation) {
        owner.rejections = 0;
        scheduleMaintenanceAfterWriteQuiet(databasePath, owner);
        return;
      }
      activeSessionKeys.forEach((key) => owner.activeSessionKeys.add(key));
      owner.rejections += 1;
      owner.running = false;
      owner.retryDelayMs = MAINTENANCE_WRITE_QUIET_MS;
      if (owner.rejections >= MAX_MAINTENANCE_REJECTIONS) {
        getChildLogger({ subsystem: "session-sqlite" }).warn(
          "SQLite automatic session maintenance paused after repeated input changes",
          { error, path: databasePath, rejections: owner.rejections },
        );
      } else {
        owner.running = true;
        owner.retryDelayMs = undefined;
        await runPendingMaintenance(databasePath, owner);
      }
      return;
    }
    // Drain cancels discretionary work; independent failures stay visible.
    if (
      !isGatewayRestartDrainError(error) &&
      !(planningChanged && getGatewayRestartDrainSignal().aborted)
    ) {
      getChildLogger({ subsystem: "session-sqlite" }).warn(
        "SQLite automatic session maintenance failed",
        { error, path: databasePath },
      );
    }
  } finally {
    preservation?.dispose();
    releaseMaintenanceExecution(databasePath, owner);
  }
  // Writes during finalization also coalesce behind the next quiet window.
  if (!isCurrent()) {
    retireMaintenanceOwner(databasePath, owner);
    return;
  }
  if (owner.generation === generation && owner.ageChanges.size === 0) {
    if (nextMaintenanceAt === undefined) {
      retireMaintenanceOwner(databasePath, owner);
      return;
    }
    owner.running = false;
    // Bound relative delays too: Node clamps overflowed timeouts to 1 ms.
    const delayMs = Math.max(
      1,
      Math.min(SESSION_ENTRY_MAINTENANCE_INTERVAL_MS, nextMaintenanceAt - Date.now()),
    );
    owner.timerDeadlineMonotonicMs = performance.now() + delayMs;
    owner.timerKind = "periodic";
    owner.timer = setTimeout(() => {
      owner.timer = undefined;
      owner.running = true;
      startPendingMaintenance(databasePath, owner);
    }, delayMs);
    owner.timer.unref();
    return;
  }
  scheduleMaintenanceAfterWriteQuiet(databasePath, owner);
}
