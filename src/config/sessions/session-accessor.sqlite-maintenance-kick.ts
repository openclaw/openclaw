import { isDeepStrictEqual } from "node:util";
import { getChildLogger } from "../../logging/logger.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { emptySessionEntryMaintenancePlan } from "./session-accessor.sqlite-maintenance-store.js";
import { finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort } from "./session-accessor.sqlite-maintenance.js";
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
};

const maintenanceByStore = new Map<string, SessionEntryMaintenanceOwner>();

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
    return;
  }
  const created: SessionEntryMaintenanceOwner = {
    ...params,
    activeSessionKeys: new Set([params.activeSessionKey]),
    database,
    generation: 1,
  };
  maintenanceByStore.set(databasePath, created);
  setImmediate(() => void runPendingMaintenance(databasePath, created));
}

async function runPendingMaintenance(
  databasePath: string,
  owner: SessionEntryMaintenanceOwner,
): Promise<void> {
  const isCurrent = () =>
    maintenanceByStore.get(databasePath) === owner && owner.database.db.isOpen;
  while (isCurrent()) {
    const generation = owner.generation;
    const activeSessionKeys = [...owner.activeSessionKeys];
    owner.activeSessionKeys.clear();
    let planningChanged = false;
    try {
      const operation = await runExclusiveSqliteSessionWrite(
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
          return createSessionMaintenancePlanningOperation({
            databaseOptions: toDatabaseOptions(owner.scope),
            input: {
              activeSessionKeys,
              archiveDirectory: owner.archiveDirectory,
              maintenance,
              preservation: null,
              storePath: owner.storePath,
            },
          });
        },
        "session.maintenance.plan",
      );
      if (!operation) {
        if (maintenanceByStore.get(databasePath) === owner) {
          maintenanceByStore.delete(databasePath);
        }
        return;
      }
      const assertCurrent = () => {
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
          throw new Error("SQLite automatic maintenance inputs changed before commit");
        }
      };
      const runPlanning = () =>
        runSqliteSessionReclamation({
          diagnostics: { kind: "maintenance-plan" },
          assertCommitAllowed: assertCurrent,
          forceInProcess: false,
          plan: operation,
        });
      let result =
        operation.input.maintenance.mode === "warn"
          ? { kind: "maintenance-plan" as const, value: emptySessionEntryMaintenancePlan() }
          : await runPlanning();
      if (result.kind === "maintenance-preservation-required") {
        await runExclusiveSqliteSessionWrite(
          owner.scope,
          async () => {
            assertCurrent();
            operation.input.preservation = captureSessionMaintenancePreservation(
              operation.input.storePath,
            );
          },
          "session.maintenance.plan",
        );
        result = await runPlanning();
      }
      if (result.kind !== "maintenance-plan") {
        throw new Error("SQLite automatic maintenance returned another operation's result");
      }
      const plan = result.value;
      await finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort(owner.scope, [plan], {
        isCurrent,
      });
    } catch (error) {
      if (planningChanged && isCurrent()) {
        owner.generation += 1;
        activeSessionKeys.forEach((key) => owner.activeSessionKeys.add(key));
      } else {
        getChildLogger({ subsystem: "session-sqlite" }).warn(
          "SQLite automatic session maintenance failed",
          { error, path: databasePath },
        );
      }
    }
    // Any write during awaited planning/finalization increments the generation.
    // Keep this owner alive so that write gets a fresh maintenance snapshot.
    if (maintenanceByStore.get(databasePath) !== owner) {
      return;
    }
    if (!owner.database.db.isOpen || owner.generation === generation) {
      maintenanceByStore.delete(databasePath);
      return;
    }
  }
  if (maintenanceByStore.get(databasePath) === owner) {
    maintenanceByStore.delete(databasePath);
  }
}
