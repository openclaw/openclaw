import { isDeepStrictEqual } from "node:util";
import { registerNodeSqliteDisposeCallback } from "../../infra/kysely-sync-cache-state.js";
import { getChildLogger } from "../../logging/logger.js";
import { isOpenClawAgentDatabasePathCurrent } from "../../state/openclaw-agent-db-identity.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  adoptSessionEntryMaintenanceAgeFact,
  captureSessionEntryMaintenanceAgeFact,
  isSessionEntryMaintenanceAgeCaptureCurrent,
  readSessionEntryMaintenanceNextAgeAt,
  SESSION_ENTRY_MAINTENANCE_INTERVAL_MS,
} from "./session-accessor.sqlite-maintenance-age.js";
import { finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort } from "./session-accessor.sqlite-maintenance.js";
import { SqliteReclamationInputsChangedError } from "./session-accessor.sqlite-reclamation-worker-diagnostics.js";
import {
  createSessionMaintenancePlanningOperation,
  runSqliteSessionReclamation,
} from "./session-accessor.sqlite-reclamation.js";
import {
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  type ResolvedSqliteReadScope,
} from "./session-accessor.sqlite-scope.js";
import { captureSessionMaintenancePreservation } from "./store-maintenance-preserve.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import {
  normalizeResolvedMaintenanceConfigInput,
  type ResolvedSessionMaintenanceConfigInput,
} from "./store-maintenance.js";

type SessionEntryMaintenanceRequest = {
  activeSessionKey: string;
  archiveDirectory: string;
  maintenanceConfig?: ResolvedSessionMaintenanceConfigInput;
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "path">;
  skipMaintenance?: boolean;
  storePath: string;
};
type SessionEntryMaintenanceOwner = SessionEntryMaintenanceRequest & {
  activeSessionKeys: Set<string>;
  database: OpenClawAgentDatabase;
  generation: number;
  running: boolean;
  rejections: number;
  retryDelayMs?: number;
  immediate?: ReturnType<typeof setImmediate>;
  timer?: ReturnType<typeof setTimeout>;
  unregisterClose?: () => void;
};

const maintenanceByStore = new Map<string, SessionEntryMaintenanceOwner>();
const MAINTENANCE_WRITE_QUIET_MS = 1_000;
const MAX_MAINTENANCE_REJECTIONS = 3;

/** Coalesce automatic logical maintenance outside ordinary entry-write latency. */
export function kickSessionEntryMaintenanceAfterWrite(
  params: SessionEntryMaintenanceRequest,
): void {
  if (params.skipMaintenance) {
    return;
  }
  const databasePath = resolveOpenClawAgentSqlitePath(toDatabaseOptions(params.scope));
  const database = getOpenClawAgentDatabaseIfOpen(toDatabaseOptions(params.scope));
  if (!database) {
    return;
  }
  const owner = maintenanceByStore.get(databasePath);
  if (owner?.database === database) {
    owner.activeSessionKeys.add(params.activeSessionKey);
    Object.assign(owner, params, { generation: owner.generation + 1 });
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
  if (owner) {
    retireMaintenanceOwner(databasePath, owner);
  }
  const created: SessionEntryMaintenanceOwner = {
    ...params,
    activeSessionKeys: new Set([params.activeSessionKey]),
    database,
    generation: 1,
    running: false,
    rejections: 0,
  };
  maintenanceByStore.set(databasePath, created);
  created.unregisterClose = registerNodeSqliteDisposeCallback(database.db, () =>
    retireMaintenanceOwner(databasePath, created),
  );
  scheduleImmediateMaintenance(databasePath, created);
}

function retireMaintenanceOwner(databasePath: string, owner: SessionEntryMaintenanceOwner): void {
  clearImmediate(owner.immediate);
  clearTimeout(owner.timer);
  owner.unregisterClose?.();
  if (maintenanceByStore.get(databasePath) === owner) {
    maintenanceByStore.delete(databasePath);
  }
}

function scheduleImmediateMaintenance(
  databasePath: string,
  owner: SessionEntryMaintenanceOwner,
): void {
  clearTimeout(owner.timer);
  owner.timer = undefined;
  owner.running = true;
  owner.immediate = setImmediate(() => {
    owner.immediate = undefined;
    void runPendingMaintenance(databasePath, owner);
  });
}

function scheduleMaintenanceAfterWriteQuiet(
  databasePath: string,
  owner: SessionEntryMaintenanceOwner,
): void {
  owner.running = false;
  owner.retryDelayMs = MAINTENANCE_WRITE_QUIET_MS * 2 ** Math.max(0, owner.rejections - 1);
  if (owner.timer) {
    // A write restarts this one-shot quiet window; no polling or competing retry owner.
    owner.timer.refresh();
    return;
  }
  owner.timer = setTimeout(() => {
    owner.timer = undefined;
    owner.retryDelayMs = undefined;
    owner.running = true;
    void runPendingMaintenance(databasePath, owner);
  }, owner.retryDelayMs);
  owner.timer.unref();
}

async function runPendingMaintenance(
  databasePath: string,
  owner: SessionEntryMaintenanceOwner,
): Promise<void> {
  const isCurrent = () =>
    maintenanceByStore.get(databasePath) === owner &&
    owner.database.db.isOpen &&
    getOpenClawAgentDatabaseIfOpen(toDatabaseOptions(owner.scope)) === owner.database;
  if (!isCurrent()) {
    retireMaintenanceOwner(databasePath, owner);
    return;
  }
  const generation = owner.generation;
  const activeSessionKeys = [...owner.activeSessionKeys];
  owner.activeSessionKeys.clear();
  let nextMaintenanceAt: number | undefined = Infinity;
  let planningChanged = false;
  try {
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
        const ageCapture = captureSessionEntryMaintenanceAgeFact(owner.database.db, maintenance);
        const operation =
          maintenance.mode === "warn"
            ? null
            : createSessionMaintenancePlanningOperation({
                databaseOptions: toDatabaseOptions(owner.scope),
                input: {
                  ageFact: ageCapture.fact,
                  activeSessionKeys,
                  archiveDirectory: owner.archiveDirectory,
                  maintenance,
                  preservation: null,
                  storePath: owner.storePath,
                },
              });
        return { maintenance, operation, ageCapture };
      },
      "session.maintenance.plan",
    );
    if (!prepared) {
      retireMaintenanceOwner(databasePath, owner);
      return;
    }
    const { maintenance, operation } = prepared;
    if (operation === null) {
      if (isCurrent() && owner.generation !== generation) {
        scheduleMaintenanceAfterWriteQuiet(databasePath, owner);
      } else {
        retireMaintenanceOwner(databasePath, owner);
      }
      return;
    }
    let { ageCapture } = prepared;
    const assertInputsCurrent = () => {
      if (!isCurrent()) {
        throw new Error("SQLite automatic maintenance owner retired");
      }
      if (
        owner.generation !== generation ||
        (operation.input.preservation !== null &&
          !isDeepStrictEqual(
            operation.input.preservation,
            captureSessionMaintenancePreservation(operation.input.storePath),
          ))
      ) {
        planningChanged = true;
        throw new SqliteReclamationInputsChangedError(
          "SQLite automatic maintenance inputs changed before commit",
        );
      }
    };
    const assertCurrent = () => {
      assertInputsCurrent();
      if (!isSessionEntryMaintenanceAgeCaptureCurrent(owner.database.db, ageCapture)) {
        planningChanged = true;
        throw new SqliteReclamationInputsChangedError(
          "SQLite automatic maintenance age fact changed before commit",
        );
      }
    };
    const runPlanning = () =>
      runSqliteSessionReclamation({
        diagnostics: { kind: "maintenance-plan" },
        assertCommitAllowed: assertCurrent,
        onWorkerResult: (result) => {
          if (result.kind === "maintenance-plan" && isCurrent()) {
            adoptSessionEntryMaintenanceAgeFact(owner.database.db, ageCapture, result.ageFact);
          }
        },
        forceInProcess: false,
        plan: operation,
      });
    let result = await runPlanning();
    if (result.kind === "maintenance-preservation-required") {
      await runExclusiveSqliteSessionWrite(
        owner.scope,
        async () => {
          assertInputsCurrent();
          // The in-process transaction also invalidates facts on rollback. Replan
          // from current owner state only after the explicit preservation rollback.
          ageCapture = captureSessionEntryMaintenanceAgeFact(
            owner.database.db,
            operation.input.maintenance,
          );
          operation.input.ageFact = ageCapture.fact;
          operation.input.preservation = captureSessionMaintenancePreservation(
            operation.input.storePath,
          );
        },
        "session.maintenance.plan",
      );
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
    if (plan.archived === 0 && plan.entryRemovals.length === 0) {
      assertInputsCurrent();
      if (!isOpenClawAgentDatabasePathCurrent(owner.database)) {
        planningChanged = true;
        throw new SqliteReclamationInputsChangedError(
          "SQLite automatic maintenance database path changed after no-op planning",
        );
      }
      // A synchronous writer can change pressure after the Worker acknowledges its fact.
      if (
        captureSessionEntryMaintenanceAgeFact(owner.database.db, maintenance).fact !==
        result.ageFact
      ) {
        planningChanged = true;
        throw new SqliteReclamationInputsChangedError(
          "SQLite automatic maintenance age fact changed after no-op planning",
        );
      }
    }
    await finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort(owner.scope, [plan], {
      isCurrent,
    });
    owner.rejections = 0;
    if (isCurrent() && owner.generation === generation) {
      nextMaintenanceAt = readSessionEntryMaintenanceNextAgeAt(owner.database, maintenance);
    }
  } catch (error) {
    if (planningChanged && isCurrent()) {
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
    getChildLogger({ subsystem: "session-sqlite" }).warn(
      "SQLite automatic session maintenance failed",
      { error, path: databasePath },
    );
  }
  // Writes during finalization also coalesce behind the next quiet window.
  if (!isCurrent()) {
    retireMaintenanceOwner(databasePath, owner);
    return;
  }
  if (owner.generation === generation) {
    if (nextMaintenanceAt === undefined) {
      retireMaintenanceOwner(databasePath, owner);
      return;
    }
    owner.running = false;
    owner.timer = setTimeout(
      () => {
        owner.timer = undefined;
        owner.running = true;
        void runPendingMaintenance(databasePath, owner);
      },
      // Bound relative delays too: Node clamps overflowed timeouts to 1 ms.
      Math.max(1, Math.min(SESSION_ENTRY_MAINTENANCE_INTERVAL_MS, nextMaintenanceAt - Date.now())),
    );
    owner.timer.unref();
    return;
  }
  scheduleMaintenanceAfterWriteQuiet(databasePath, owner);
}
