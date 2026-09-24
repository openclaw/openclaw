import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { SqliteCoordinatorError } from "./sqlite-coordinator.js";
import type { StateDatabaseCoordinatorOwner } from "./state-database-coordinator-owner.js";
import type { CoordinatorFamily } from "./state-database-coordinator-paths.js";

export const StateDatabaseCoordinatorContentionError = resolveGlobalSingleton(
  Symbol.for("openclaw.stateDatabaseCoordinatorContentionError"),
  () =>
    class CoordinatorContentionError extends SqliteCoordinatorError {
      constructor(
        readonly family: CoordinatorFamily,
        readonly blockingOwner?: StateDatabaseCoordinatorOwner,
      ) {
        super(
          `another OpenClaw process owns ${family}${blockingOwner ? ` holder=${JSON.stringify(blockingOwner)}` : ""}`,
        );
        this.name = "StateDatabaseCoordinatorContentionError";
      }
    },
);
export type StateDatabaseCoordinatorContentionError = InstanceType<
  typeof StateDatabaseCoordinatorContentionError
>;

export const StateSchemaMutationConflictError = resolveGlobalSingleton(
  Symbol.for("openclaw.stateSchemaMutationConflictError"),
  () =>
    class SchemaMutationConflictError extends SqliteCoordinatorError {
      constructor(databasePath: string, cause: unknown) {
        super(
          `OpenClaw refused shared state schema mutation at ${databasePath} because another Gateway owns that state directory. Stop that Gateway or perform the update through its managed restart path, then retry.`,
          cause,
        );
        this.name = "StateSchemaMutationConflictError";
      }
    },
);
export type StateSchemaMutationConflictError = InstanceType<
  typeof StateSchemaMutationConflictError
>;
