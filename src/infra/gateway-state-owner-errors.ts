import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { LockPayload } from "./gateway-lock-payload.js";

export class StateDatabaseAccessError extends Error {
  override name = "StateDatabaseAccessError";
}

export const GatewayStateOwnerContentionError = resolveGlobalSingleton(
  Symbol.for("openclaw.gatewayStateOwnerContentionError"),
  () =>
    class StateOwnerContentionError extends Error {
      constructor(
        public readonly databasePath: string,
        public override readonly cause?: unknown,
        public readonly holderDetail?: string,
        /** Recorded holder identity: diagnostic evidence for waiting, never ownership authority. */
        public readonly holder?: Pick<LockPayload, "pid" | "role">,
      ) {
        super(
          `OpenClaw state database is busy at ${databasePath}. ${holderDetail ? `${holderDetail} ` : ""}Wait for the other OpenClaw process to finish, then retry. If it persists, run \`openclaw gateway status\` and check for other OpenClaw processes using the same state directory. A running Gateway can hold this ownership until it stops; stop it through its service manager or original terminal before retrying.`,
        );
        this.name = "GatewayStateOwnerContentionError";
      }
    },
);
export type GatewayStateOwnerContentionError = InstanceType<
  typeof GatewayStateOwnerContentionError
>;

/** A local holder exists, but the caller has no live lexical maintenance authority. */
export const StateDatabaseMaintenanceScopeError = resolveGlobalSingleton(
  Symbol.for("openclaw.stateDatabaseMaintenanceScopeError"),
  () =>
    class extends StateDatabaseAccessError {
      override name = "StateDatabaseMaintenanceScopeError";

      constructor(databasePath: string) {
        super(
          `Internal state ownership error at ${databasePath}: this process holds maintenance ownership without an active schema lease or maintenance scope. Retry the command; if it persists, report this error.`,
        );
      }
    },
);

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
