import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export class StateDatabaseAccessError extends Error {
  override name = "StateDatabaseAccessError";
}

export const StateDatabaseAdmissionPendingError = resolveGlobalSingleton(
  Symbol.for("openclaw.stateDatabaseAdmissionPendingError"),
  () =>
    class extends StateDatabaseAccessError {
      constructor(
        readonly databasePath: string,
        message: string,
      ) {
        super(message);
      }
    },
);

/** A live foreign process holds offline-maintenance custody of this database. */
export const StateDatabaseOfflineMaintenanceError = resolveGlobalSingleton(
  Symbol.for("openclaw.stateDatabaseOfflineMaintenanceError"),
  () =>
    class extends StateDatabaseAccessError {
      constructor(
        readonly databasePath: string,
        message: string,
      ) {
        super(message);
      }
    },
);
