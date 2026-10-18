import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getCliParentPid } from "../../cli-parent-lifetime.mjs";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { getFileLockProcessStartTime, isPidAlive } from "../shared/pid-alive.js";
import { resolveOpenClawStateDirForDatabasePath } from "../state/openclaw-state-db.paths.js";
import {
  classifyGatewayLockProcessNamespace,
  GatewayLockNamespaceError,
  parseGatewayLockPayload,
  readGatewayLockProcessNamespace,
  type LockPayload,
} from "./gateway-lock-payload.js";
import { isLockOwnerDefinitelyStale } from "./stale-lock-file.js";

/** Admission and reclamation use the same namespace-qualified PID evidence. */
export function isGatewayStateOwnerDefinitelyStale(value: unknown, lockPath: string): boolean {
  const payload = isRecord(value) ? value : null;
  const namespace = classifyGatewayLockProcessNamespace(payload?.processNamespace, lockPath);
  if (namespace === "unknown") {
    throw new GatewayLockNamespaceError(payload ?? {}, lockPath);
  }
  return (
    namespace === "dead" ||
    isLockOwnerDefinitelyStale({
      payload: payload ? { pid: payload.pid, starttime: payload.startTime } : null,
    })
  );
}

class StateDatabaseAccessError extends Error {
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

      constructor(readonly databasePath: string) {
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

export const isStateDatabaseMaintenanceContention = (error: unknown): boolean =>
  error instanceof AggregateError
    ? error.errors.length > 0 && error.errors.every(isStateDatabaseMaintenanceContention)
    : error instanceof StateDatabaseAdmissionPendingError ||
      error instanceof StateDatabaseOfflineMaintenanceError;

/** Persisted ownership can identify a holder but cannot lend this process maintenance authority. */
export function assertPersistedStateDatabaseAccessAllowed(params: {
  databasePath: string;
  ownerPath: string;
  assertMaintenance: () => void;
}): void {
  const { databasePath, ownerPath, assertMaintenance } = params;
  const unavailable = `OpenClaw state ownership at ${databasePath} could not be verified from ${ownerPath}; restart the Gateway.`;
  let raw: string;
  try {
    raw = fs.readFileSync(ownerPath, "utf8");
  } catch (error) {
    if (extractErrorCode(error) === "ENOENT") {
      return;
    }
    throw new StateDatabaseAccessError(unavailable, { cause: error });
  }
  const owner = parseGatewayLockPayload(raw);
  if (!owner) {
    // Native exclusive creation precedes the payload write; cold admission may wait for publication.
    throw new StateDatabaseAdmissionPendingError(databasePath, unavailable);
  }
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
    throw new StateDatabaseAccessError(unavailable);
  }
  if (isGatewayStateOwnerDefinitelyStale(owner, ownerPath)) {
    return;
  }
  // Workers share the process PID, but their schema authority still comes from
  // the host operation's retained lease and is never inferred from this record.
  if (owner.pid === process.pid && !isMainThread) {
    return;
  }
  if (!isPidAlive(owner.pid)) {
    throw new StateDatabaseAccessError(unavailable);
  }
  const role = owner.role ?? "gateway";
  if (role === "gateway" || role === "agent-embedded") {
    return;
  }
  if (owner.pid === process.pid) {
    assertMaintenance();
    return;
  }
  const maintenancePending = `OpenClaw state at ${databasePath} is undergoing offline maintenance by ${role} process ${owner.pid}; retry when it finishes.`;
  if (owner.stateOwnerKind === "schema" && owner.role === "sqlite-maintenance") {
    throw new StateDatabaseAdmissionPendingError(databasePath, maintenancePending);
  }
  throw new StateDatabaseOfflineMaintenanceError(databasePath, maintenancePending);
}

export function defaultPayload(databasePath: string): LockPayload {
  const stateDir = resolveOpenClawStateDirForDatabasePath(databasePath);
  const startTime = getFileLockProcessStartTime(process.pid);
  const parentPid = getCliParentPid();
  const parentStartTime = parentPid === undefined ? null : getFileLockProcessStartTime(parentPid);
  return {
    pid: process.pid,
    ownerId: randomUUID(),
    createdAt: new Date().toISOString(),
    stateDir,
    configPath: path.join(stateDir, "openclaw.json"),
    role: "sqlite-maintenance",
    processNamespace: readGatewayLockProcessNamespace(),
    ...(parentPid === undefined ? {} : { parentPid }),
    ...(parentStartTime === null ? {} : { parentStartTime }),
    ...(startTime === null ? {} : { startTime }),
  };
}
