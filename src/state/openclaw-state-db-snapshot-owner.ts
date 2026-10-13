import type { DatabaseSync } from "node:sqlite";
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
    release(database: DatabaseSync): void {
      releases.get(database)?.();
      releases.delete(database);
    },
  };
}

export const openClawStateSnapshotOwners = resolveGlobalSingleton(
  Symbol.for("openclaw.stateSnapshotOwners"),
  createOpenClawStateSnapshotOwnerRegistry,
);
