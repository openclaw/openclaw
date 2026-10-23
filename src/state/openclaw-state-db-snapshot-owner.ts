import type { DatabaseSync } from "node:sqlite";
import type { EngineConnection } from "../infra/sql-connection.js";
import { isPostgresSqlConnection } from "../infra/sql-connection.js";
import { registerLiveSqliteSnapshotOwner } from "../infra/sqlite-live-snapshot.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";

function createOpenClawStateSnapshotOwnerRegistry() {
  const releases = new WeakMap<DatabaseSync, () => void>();
  return {
    register(
      database: OpenClawStateDatabase,
      getCurrent: () => OpenClawStateDatabase | undefined,
    ): void {
      if (isPostgresSqlConnection(database.db)) {
        return;
      }
      releases.set(
        database.db,
        registerLiveSqliteSnapshotOwner({
          database: database.db,
          databasePath: database.path,
          owner: "openclaw-state",
          assertCurrent: () => {
            if (getCurrent() !== database || !database.db.isOpen) {
              throw new Error("OpenClaw state snapshot owner is no longer current");
            }
          },
        }),
      );
    },
    release(database: EngineConnection): void {
      if (isPostgresSqlConnection(database)) {
        return;
      }
      releases.get(database)?.();
      releases.delete(database);
    },
  };
}

export const openClawStateSnapshotOwners = resolveGlobalSingleton(
  Symbol.for("openclaw.stateSnapshotOwners"),
  createOpenClawStateSnapshotOwnerRegistry,
);
