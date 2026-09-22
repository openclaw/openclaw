import { registerNodeSqliteDisposeCallback } from "../../infra/kysely-sync-cache-state.js";
import { getChildLogger } from "../../logging/logger.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { SESSION_ENTRY_MAINTENANCE_INTERVAL_MS } from "./session-accessor.sqlite-maintenance-age.js";
import {
  applySessionEntryMaintenance,
  finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort,
  readNextSessionEntryMaintenanceAt,
} from "./session-accessor.sqlite-maintenance.js";
import {
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  type ResolvedSqliteReadScope,
} from "./session-accessor.sqlite-scope.js";
import type { ResolvedSessionMaintenanceConfigInput } from "./store-maintenance.js";

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
  immediate?: ReturnType<typeof setImmediate>;
  timer?: ReturnType<typeof setTimeout>;
  unregisterClose?: () => void;
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
    if (!owner.running) {
      scheduleImmediateMaintenance(databasePath, owner);
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

async function runPendingMaintenance(
  databasePath: string,
  owner: SessionEntryMaintenanceOwner,
): Promise<void> {
  const isCurrent = () =>
    maintenanceByStore.get(databasePath) === owner &&
    owner.database.db.isOpen &&
    getOpenClawAgentDatabaseIfOpen(toDatabaseOptions(owner.scope)) === owner.database;
  while (isCurrent()) {
    const generation = owner.generation;
    const activeSessionKeys = [...owner.activeSessionKeys];
    owner.activeSessionKeys.clear();
    let nextMaintenanceAt: number | undefined = Infinity;
    try {
      const plan = await runExclusiveSqliteSessionWrite(
        owner.scope,
        async () => {
          // The writer queue can outlive the handle that admitted this owner.
          // Check inside the acquired lane so an evicted owner cannot reopen the path.
          if (!isCurrent()) {
            return undefined;
          }
          return runOpenClawAgentWriteTransaction(
            (database) =>
              applySessionEntryMaintenance(database, {
                activeSessionKeys,
                archiveDirectory: owner.archiveDirectory,
                maintenanceConfig: owner.maintenanceConfig,
                storePath: owner.storePath,
              }),
            toDatabaseOptions(owner.scope),
          );
        },
        "session.maintenance.plan",
      );
      if (!plan) {
        break;
      }
      await finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort(owner.scope, [plan], {
        isCurrent,
      });
      if (isCurrent()) {
        nextMaintenanceAt = readNextSessionEntryMaintenanceAt(
          owner.database,
          owner.maintenanceConfig,
        );
      }
    } catch (error) {
      getChildLogger({ subsystem: "session-sqlite" }).warn(
        "SQLite automatic session maintenance failed",
        { error, path: databasePath },
      );
    }
    // Any write during awaited planning/finalization increments the generation.
    // Keep this owner alive so that write gets a fresh maintenance snapshot.
    if (!isCurrent()) {
      break;
    }
    if (owner.generation === generation) {
      if (nextMaintenanceAt === undefined) {
        break;
      }
      owner.running = false;
      owner.timer = setTimeout(
        () => {
          owner.timer = undefined;
          owner.running = true;
          void runPendingMaintenance(databasePath, owner);
        },
        // Bound relative delays too: Node clamps overflowed timeouts to 1 ms.
        Math.max(
          1,
          Math.min(SESSION_ENTRY_MAINTENANCE_INTERVAL_MS, nextMaintenanceAt - Date.now()),
        ),
      );
      owner.timer.unref();
      return;
    }
  }
  retireMaintenanceOwner(databasePath, owner);
}
