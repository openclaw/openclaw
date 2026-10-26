import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getCliParentPid } from "../../cli-parent-lifetime.mjs";
import { getFileLockProcessStartTime, isPidAlive } from "../shared/pid-alive.js";
import { resolveOpenClawStateDirForDatabasePath } from "../state/openclaw-state-db.paths.js";
import { readProcessMachineIdentity } from "./current-machine-identity.js";
import { acquireFileLockSync } from "./file-lock-manager.js";
import {
  classifyGatewayLockProcessNamespace,
  describeGatewayLockHolder,
  LockPayloadSchema,
  GatewayLockNamespaceError,
  parseGatewayLockPayload,
  readGatewayLockProcessNamespace,
  type LockPayload,
} from "./gateway-lock-payload.js";
import {
  ensureOwnerDirectory,
  type StateOwnerDirectoryIdentity,
} from "./gateway-state-owner-directory.js";
import {
  GatewayStateOwnerContentionError,
  StateDatabaseAccessError,
  StateDatabaseAdmissionPendingError,
  StateDatabaseOfflineMaintenanceError,
} from "./gateway-state-owner-errors.js";
import { isLockOwnerDefinitelyStale } from "./stale-lock-file.js";

function isComparableStateOwnerStale(
  payload: Record<string, unknown>,
  namespace: "same" | "dead" | "unknown",
): boolean {
  return (
    namespace === "dead" ||
    (namespace === "same" &&
      isLockOwnerDefinitelyStale({ payload: { pid: payload.pid, starttime: payload.startTime } }))
  );
}

/** Reclamation requires proof that the recorded owner stopped. */
export function isGatewayStateOwnerDefinitelyStale(value: unknown, lockPath: string): boolean {
  const payload = isRecord(value) ? value : null;
  if (!payload) {
    // Exclusive creation precedes publication; an incomplete record still owns its lock.
    return false;
  }
  const namespace = classifyGatewayLockProcessNamespace(payload, lockPath);
  if (namespace === "unknown") {
    throw new GatewayLockNamespaceError(payload, lockPath);
  }
  return isComparableStateOwnerStale(payload, namespace);
}

export {
  GatewayStateOwnerContentionError,
  StateDatabaseAdmissionPendingError,
  StateDatabaseMaintenanceScopeError,
  StateDatabaseOfflineMaintenanceError,
} from "./gateway-state-owner-errors.js";

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
  // Ordinary SQLite access does not reclaim the owner or borrow schema custody.
  // Unknown namespaces retain maintenance contention without probing a local PID.
  const namespace = classifyGatewayLockProcessNamespace(owner, ownerPath);
  if (isComparableStateOwnerStale(owner, namespace)) {
    return;
  }
  // Workers share the process PID, but their schema authority still comes from
  // the host operation's retained lease and is never inferred from this record.
  if (namespace === "same" && owner.pid === process.pid && !isMainThread) {
    return;
  }
  if (namespace === "same" && !isPidAlive(owner.pid)) {
    throw new StateDatabaseAccessError(unavailable);
  }
  const role = owner.role ?? "gateway";
  if (role === "gateway" || role === "agent-embedded") {
    return;
  }
  if (namespace === "same" && owner.pid === process.pid) {
    assertMaintenance();
    return;
  }
  const maintenancePending = `OpenClaw state at ${databasePath} is undergoing offline maintenance by ${role} process ${owner.pid}; retry when it finishes. For update progress, run \`openclaw update status --json\`.`;
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
    machineIdentity: process.platform === "darwin" ? readProcessMachineIdentity() : undefined,
    ...(parentPid === undefined ? {} : { parentPid }),
    ...(parentStartTime === null ? {} : { parentStartTime }),
    ...(startTime === null ? {} : { startTime }),
  };
}

export function acquireGatewayStateOwnerFile(
  databasePath: string,
  pathname: string,
  payload: LockPayload,
  busyTimeoutMs = 0,
  createdDirectories?: StateOwnerDirectoryIdentity[],
) {
  const deadline = performance.now() + busyTimeoutMs;
  ensureOwnerDirectory(path.dirname(pathname), createdDirectories);
  const observed: { holder: LockPayload | null } = { holder: null };
  const stale = ({ payload: value }: { payload: unknown }) => {
    observed.holder = LockPayloadSchema.safeParse(value).data ?? null;
    return isGatewayStateOwnerDefinitelyStale(observed.holder, pathname);
  };
  if (busyTimeoutMs > 0) {
    try {
      const previous = (observed.holder = parseGatewayLockPayload(
        fs.readFileSync(pathname, "utf8"),
      ));
      if (
        previous &&
        !isGatewayStateOwnerDefinitelyStale(previous, pathname) &&
        (previous.pid === process.pid ||
          ((previous.role ?? "gateway") === "gateway" && isPidAlive(previous.pid)))
      ) {
        // A serving Gateway cannot lend schema authority. An unregistered local
        // holder may need this host to service grants, so it cannot be waited on.
        throw new GatewayStateOwnerContentionError(databasePath);
      }
    } catch (error) {
      if (extractErrorCode(error) !== "ENOENT") {
        throw error;
      }
    }
  }
  for (let retriedMissingParent = false; ;) {
    try {
      return acquireFileLockSync(pathname, {
        lockPath: pathname,
        retry:
          busyTimeoutMs > 0
            ? { factor: 1.25, minTimeout: 10, maxTimeout: 25, randomize: false }
            : { retries: 0 },
        timeoutMs: Math.max(0, Math.ceil(deadline - performance.now())),
        staleMs: Infinity,
        staleRecovery: "remove-if-unchanged",
        reentrantOwner: payload.ownerId,
        payload: () => payload,
        // Reclamation validates foreign payloads; held custody compares exact bytes and token.
        shouldReclaim: stale,
        shouldRemoveStaleLock: stale,
      });
    } catch (error) {
      const code = extractErrorCode(error);
      if (code === "ENOENT" && !retriedMissingParent) {
        // Final lease cleanup can remove the parent before exclusive creation.
        // Recreate it once without extending the original contention budget.
        retriedMissingParent = true;
        ensureOwnerDirectory(path.dirname(pathname), createdDirectories);
        continue;
      }
      if (code === "file_lock_timeout" || code === "file_lock_stale") {
        const { holder } = observed;
        const holderDetail = describeGatewayLockHolder(
          holder ?? {},
          pathname,
          holder && isPidAlive(holder.pid) ? "live" : "unknown",
        );
        throw new GatewayStateOwnerContentionError(
          databasePath,
          error,
          holderDetail,
          holder ? { pid: holder.pid, role: holder.role } : undefined,
        );
      }
      throw error;
    }
  }
}
