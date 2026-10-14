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
import { observeSessionWorkAdmissionReleases } from "../../sessions/session-lifecycle-admission.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
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
import { readPreparedSessionEntryPublicationSource } from "./session-accessor.sqlite-entry-cache-publication-state.js";
import type {
  SqliteSessionReclamationPlan,
  SqliteSessionReclamationResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import {
  SESSION_ENTRY_MAINTENANCE_INTERVAL_MS,
  capturePendingSessionMaintenanceAgeChanges,
  observeSessionEntryMaintenanceAgeChanges,
  updateSessionEntryMaintenanceAgeFact,
  type SessionEntryMaintenanceAgeFact,
  type SessionEntryMaintenanceAgeChange,
} from "./session-accessor.sqlite-maintenance-age.js";
import { finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort } from "./session-accessor.sqlite-maintenance.js";
import { runSqliteSessionReclamation } from "./session-accessor.sqlite-reclamation-run.js";
import { SqliteReclamationInputsChangedError } from "./session-accessor.sqlite-reclamation-worker-diagnostics.js";
import { resolveSessionReclamationDatabaseOptions } from "./session-accessor.sqlite-reclamation.js";
import {
  toDatabaseOptions,
  type ResolvedSqliteReadScope,
} from "./session-accessor.sqlite-scope.js";
import { assertMaintenancePreservationCompatible } from "./store-maintenance-preserve-snapshot.js";
import { prepareSessionMaintenancePreservation } from "./store-maintenance-preserve.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import {
  normalizeResolvedMaintenanceConfigInput,
  shouldRunSessionEntryMaintenance,
  shouldPreserveMaintenanceEntry,
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
  ageFact?: SessionEntryMaintenanceAgeFact;
  noCandidates?: boolean;
  rejections: number;
  retryDelayMs?: number;
  immediate?: ReturnType<typeof setImmediate>;
  timer?: ReturnType<typeof setTimeout>;
  timerDeadlineMonotonicMs?: number;
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
  if (owner) {
    owner.activeSessionKeys.add(params.activeSessionKey);
    Object.assign(owner, params, { scope: owner.scope, generation: owner.generation + 1 });
    const maintenance = resolveOwnerMaintenance(owner);
    const fact = owner.ageFact;
    if (
      !owner.running &&
      fact?.entryCount !== undefined &&
      isDeepStrictEqual(fact.maintenance, maintenance) &&
      Date.now() < Math.min(fact.next.at, fact.recheckAt) &&
      (owner.noCandidates ||
        !shouldRunSessionEntryMaintenance({
          entryCount: fact.entryCount,
          maxEntries: maintenance.maxEntries,
        }))
    ) {
      // Acknowledged activity cannot require a scan before this conservative deadline.
      owner.activeSessionKeys.clear();
      const nextAt = Math.min(fact.next.at, fact.recheckAt);
      if (nextAt - Date.now() < (owner.timerDeadlineMonotonicMs ?? Infinity) - performance.now()) {
        scheduleMaintenanceAt(databasePath, owner, nextAt);
      }
      return;
    }
    if (!owner.running) {
      if (owner.retryDelayMs !== undefined) {
        if (owner.rejections >= MAX_MAINTENANCE_REJECTIONS) {
          owner.rejections = 0;
        }
        scheduleMaintenanceAfterWriteQuiet(databasePath, owner);
      } else {
        scheduleImmediateMaintenance(databasePath, owner);
      }
    }
    return;
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
    unregister.push(
      observeSessionWorkAdmissionReleases(created.storePath, () => {
        if (
          created.noCandidates ||
          (!created.running &&
            created.ageFact?.entryCount !== undefined &&
            !shouldRunSessionEntryMaintenance({
              entryCount: created.ageFact.entryCount,
              maxEntries: resolveOwnerMaintenance(created).maxEntries,
            }))
        ) {
          return;
        }
        if (!isMaintenanceOwnerCurrent(databasePath, created)) {
          return;
        }
        created.generation += 1;
        created.rejections = 0;
        if (!created.running) {
          // Replace an age deadline, but keep an already coalesced quiet-window retry.
          if (created.retryDelayMs === undefined) {
            clearTimeout(created.timer);
            created.timer = undefined;
          }
          scheduleMaintenanceAfterWriteQuiet(databasePath, created);
        }
      }),
    );
    if (identity) {
      unregister.push(
        observeSessionEntryMaintenanceAgeChanges(identity.key.slice(5), (change) => {
          const previousFact = created.ageFact;
          created.ageFact = updateSessionEntryMaintenanceAgeFact(created.ageFact, change);
          const invalidated = previousFact !== undefined && created.ageFact === undefined;
          if (!created.ageFact) {
            created.noCandidates = false;
          }
          const previous = created.ageChanges.get(change.sessionKey);
          created.ageChanges.set(change.sessionKey, {
            ...change,
            previousEntry: previous ? previous.previousEntry : change.previousEntry,
          });
          if (!change.previousEntry || invalidated) {
            const preserved =
              change.entry.preserved ??
              shouldPreserveMaintenanceEntry({
                key: change.sessionKey,
                entry: change.entry,
                preserveRecentMs: null,
              });
            const fact = created.ageFact;
            const resume =
              !created.running &&
              (invalidated ||
                (created.noCandidates
                  ? !preserved
                  : fact?.entryCount !== undefined &&
                    shouldRunSessionEntryMaintenance({
                      entryCount: fact.entryCount,
                      maxEntries: fact.maintenance.maxEntries,
                    })));
            if (!preserved) {
              created.noCandidates = false;
            }
            if (resume) {
              if (created.retryDelayMs !== undefined) {
                if (created.rejections >= MAX_MAINTENANCE_REJECTIONS) {
                  created.rejections = 0;
                }
                scheduleMaintenanceAfterWriteQuiet(databasePath, created);
              } else {
                scheduleImmediateMaintenance(databasePath, created);
              }
            }
          }
        }),
      );
      unregister.push(
        sessionChanges.subscribeFacts((change) => {
          if (
            change.factsInvalidated !== true &&
            !("facts" in change && change.facts?.kind === "removed")
          ) {
            return;
          }
          const source = readPreparedSessionEntryPublicationSource(change);
          const storePath =
            "all" in change
              ? typeof change.scope === "object"
                ? change.scope.storePath
                : undefined
              : change.storePath;
          if (source.identity !== identity.key.slice(5) && storePath !== databasePath) {
            return;
          }
          created.ageFact = undefined;
          created.noCandidates = false;
          created.generation += 1;
          if (!created.running) {
            scheduleImmediateMaintenance(databasePath, created);
          }
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

function resolveOwnerMaintenance(owner: SessionEntryMaintenanceOwner) {
  return owner.maintenanceConfig
    ? normalizeResolvedMaintenanceConfigInput(owner.maintenanceConfig)
    : resolveMaintenanceConfig();
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

function scheduleImmediateMaintenance(
  databasePath: string,
  owner: SessionEntryMaintenanceOwner,
): void {
  clearTimeout(owner.timer);
  owner.timer = undefined;
  owner.retryDelayMs = undefined;
  owner.timerDeadlineMonotonicMs = undefined;
  owner.running = true;
  // Database maintenance outlives the writer's turn and carries its own admission.
  owner.immediate = runInDetachedAsyncContext(() =>
    setImmediate(() => {
      owner.immediate = undefined;
      startPendingMaintenance(databasePath, owner);
    }),
  );
}

function scheduleMaintenanceAt(
  databasePath: string,
  owner: SessionEntryMaintenanceOwner,
  nextAt: number,
): void {
  // Bound relative delays: Node clamps overflowed timeouts to 1 ms.
  const delayMs = Math.max(1, Math.min(SESSION_ENTRY_MAINTENANCE_INTERVAL_MS, nextAt - Date.now()));
  clearTimeout(owner.timer);
  owner.retryDelayMs = undefined;
  owner.running = false;
  owner.timerDeadlineMonotonicMs = performance.now() + delayMs;
  owner.timer = runInDetachedAsyncContext(() =>
    setTimeout(() => {
      owner.running = true;
      startPendingMaintenance(databasePath, owner);
    }, delayMs),
  );
  owner.timer.unref();
}

function scheduleMaintenanceAfterWriteQuiet(
  databasePath: string,
  owner: SessionEntryMaintenanceOwner,
): void {
  owner.running = false;
  if (owner.timer) {
    // Coalesce writes without letting sustained activity postpone this retry indefinitely.
    return;
  }
  owner.retryDelayMs = MAINTENANCE_WRITE_QUIET_MS * 2 ** Math.max(0, owner.rejections - 1);
  owner.timerDeadlineMonotonicMs = performance.now() + owner.retryDelayMs;
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
  // Publish the join before a pass can synchronously retire itself.
  owner.active = Promise.resolve().then(async () => {
    if (!isMaintenanceOwnerCurrent(databasePath, owner)) {
      retireMaintenanceOwner(databasePath, owner);
      return;
    }
    // Keep command cleanup custody while automatic work uses the runtime worker path.
    const run = () => runPendingMaintenance(databasePath, owner);
    await (owner.maintenanceResource ? owner.maintenanceResource.runWorker(run) : run());
  });
}

async function runPendingMaintenance(
  databasePath: string,
  owner: SessionEntryMaintenanceOwner,
): Promise<void> {
  const isCurrent = () => isMaintenanceOwnerCurrent(databasePath, owner);
  const hasCurrentNoCandidates = () =>
    owner.noCandidates === true &&
    owner.ageFact?.entryCount !== undefined &&
    isDeepStrictEqual(owner.ageFact.maintenance, resolveOwnerMaintenance(owner));
  const installAgeFact = (fact: SessionEntryMaintenanceAgeFact | undefined) => {
    owner.ageFact = fact;
    for (const change of owner.ageChanges.values()) {
      owner.ageFact = updateSessionEntryMaintenanceAgeFact(owner.ageFact, change);
    }
  };
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
  try {
    owner.execution ??= owner.captureExecution();
    const maintenance = resolveOwnerMaintenance(owner);
    if (maintenance.mode === "warn") {
      retireMaintenanceOwner(databasePath, owner);
      return;
    }
    const assertInputsCurrent = () => {
      if (!isCurrent()) {
        if (getGatewayRestartDrainSignal().aborted) {
          throw new GatewayDrainingError();
        }
        planningChanged = true;
        throw new SqliteReclamationInputsChangedError("SQLite automatic maintenance owner retired");
      }
    };
    const preparedPreservation = await prepareSessionMaintenancePreservation(owner.storePath);
    preservation = preparedPreservation;
    assertInputsCurrent();
    const capturePreservation = () => {
      try {
        return preparedPreservation.capture();
      } catch (error) {
        planningChanged = true;
        throw error;
      }
    };
    // A running pass keeps its captured policy; configuration changes apply to the next pass.
    const operation: Extract<SqliteSessionReclamationPlan, { kind: "maintenance-plan" }> & {
      input: { activeSessionKeys: string[] };
    } = {
      databaseOptions: resolveSessionReclamationDatabaseOptions(toDatabaseOptions(owner.scope)),
      kind: "maintenance-plan",
      materializedPlans: [],
      input: {
        activeSessionKeys,
        archiveDirectory: owner.archiveDirectory,
        maintenance,
        preservation: capturePreservation(),
        storePath: owner.storePath,
      },
    };
    const plannedChanges = capturePendingSessionMaintenanceAgeChanges(owner.ageChanges);
    operation.ageChanges = plannedChanges.changes;
    let planningConsumed = false;
    const consumePlanning = (completed: SqliteSessionReclamationResult) => {
      if (completed.kind !== "maintenance-plan") {
        return;
      }
      assertInputsCurrent();
      plannedChanges.acknowledge();
      installAgeFact(completed.ageFact);
      const plan = completed.value;
      owner.noCandidates =
        plan.archived === 0 &&
        plan.entryRemovals.length === 0 &&
        plan.stateDeletePlans.length === 0 &&
        plan.durableNoCandidates === true &&
        owner.generation === generation &&
        owner.ageChanges.size === 0 &&
        owner.ageFact?.entryCount !== undefined &&
        isDeepStrictEqual(owner.ageFact.maintenance, resolveOwnerMaintenance(owner));
      planningConsumed = true;
    };
    const result = await runSqliteSessionReclamation({
      diagnostics: { kind: "maintenance-plan" },
      assertCommitAllowed: assertInputsCurrent,
      // Consume the committed worker proof under FIFO; later observers retain invalidation ownership.
      onWorkerResult: consumePlanning,
      assertMaintenanceCommitAllowed(plans) {
        assertInputsCurrent();
        try {
          // A late kick can protect an ancestor; the next writer refresh resolves that ancestry.
          if ([...owner.activeSessionKeys].some((key) => !activeSessionKeys.includes(key))) {
            throw new SqliteReclamationInputsChangedError("SQLite maintenance active keys changed");
          }
          assertMaintenancePreservationCompatible(
            operation.input.preservation,
            capturePreservation(),
            plans,
          );
        } catch (error) {
          planningChanged = true;
          throw error;
        }
      },
      refreshMaintenanceProtection: () => {
        // Preparation can yield to foreground writes; commit checks only affected protection.
        assertInputsCurrent();
        activeSessionKeys = [...new Set([...activeSessionKeys, ...owner.activeSessionKeys])];
        return {
          activeSessionKeys,
          preservation: capturePreservation(),
          preparedAgeFactCurrent:
            owner.generation === generation &&
            plannedChanges.isCurrent() &&
            isDeepStrictEqual(maintenance, resolveOwnerMaintenance(owner)),
        };
      },
      plan: operation,
    });
    if (!planningConsumed) {
      // Doctor/native execution has no worker publication; its generation guard stays conservative.
      consumePlanning(result);
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
      const pending = capturePendingSessionMaintenanceAgeChanges(owner.ageChanges);
      const age = await runSqliteSessionReclamation({
        diagnostics: { kind: "maintenance-age" },
        assertCommitAllowed: assertInputsCurrent,
        plan: {
          kind: "maintenance-age",
          databaseOptions: operation.databaseOptions,
          materializedPlans: [],
          maintenance,
          ageChanges: pending.changes,
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
      installAgeFact(age.ageFact);
      return age.nextAt;
    };
    const noChanges = plan.archived === 0 && plan.entryRemovals.length === 0;
    const noFinalization = noChanges && plan.stateDeletePlans.length === 0;
    const verifiedNextAt = noChanges ? result.nextAt : undefined;
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
      nextMaintenanceAt = noFinalization ? verifiedNextAt : await readAge();
      if (owner.ageChanges.size > 0 && !hasCurrentNoCandidates()) {
        planningChanged = true;
        throw new SqliteReclamationInputsChangedError(
          "SQLite automatic maintenance activity changed during age publication",
        );
      }
    }
    owner.rejections = 0;
    if (noFinalization && !owner.ageFact && isCurrent()) {
      // Unknown writes invalidate age facts; their due deadline must retain the quiet window.
      scheduleMaintenanceAfterWriteQuiet(databasePath, owner);
      return;
    }
    if (
      operation.input.activeSessionKeys.length > 0 &&
      !hasCurrentNoCandidates() &&
      (owner.ageFact?.entryCount === undefined ||
        shouldRunSessionEntryMaintenance({
          entryCount: owner.ageFact.entryCount,
          maxEntries: maintenance.maxEntries,
        })) &&
      isCurrent()
    ) {
      // An age-only read can omit the count; reconsider released write protection once.
      scheduleMaintenanceAfterWriteQuiet(databasePath, owner);
      return;
    }
  } catch (error) {
    owner.noCandidates = false;
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
        scheduleMaintenanceAfterWriteQuiet(databasePath, owner);
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
  const fact = owner.ageFact;
  if (fact && hasCurrentNoCandidates()) {
    owner.activeSessionKeys.clear();
    scheduleMaintenanceAt(databasePath, owner, Math.min(fact.next.at, fact.recheckAt));
    return;
  }
  if (owner.generation === generation && owner.ageChanges.size === 0) {
    if (nextMaintenanceAt === undefined) {
      retireMaintenanceOwner(databasePath, owner);
      return;
    }
    scheduleMaintenanceAt(databasePath, owner, nextMaintenanceAt);
    return;
  }
  scheduleMaintenanceAfterWriteQuiet(databasePath, owner);
}
