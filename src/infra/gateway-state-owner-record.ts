import fs from "node:fs";
import { isMainThread } from "node:worker_threads";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { isPidAlive } from "../shared/pid-alive.js";
import {
  classifyGatewayLockProcessNamespace,
  GatewayLockNamespaceError,
  parseGatewayLockPayload,
} from "./gateway-lock-payload.js";
import { isLockOwnerDefinitelyStale } from "./stale-lock-file.js";

/** Admission and reclamation use the same namespace-qualified PID evidence. */
export function isGatewayStateOwnerDefinitelyStale(value: unknown, lockPath: string): boolean {
  const payload = isRecord(value) ? value : null;
  const namespace = classifyGatewayLockProcessNamespace(payload?.processNamespace, lockPath);
  if (namespace === "unknown") {
    throw new GatewayLockNamespaceError();
  }
  return (
    namespace === "dead" ||
    isLockOwnerDefinitelyStale({
      payload: payload ? { pid: payload.pid, starttime: payload.startTime } : null,
    })
  );
}

export const StateDatabaseAdmissionPendingError = resolveGlobalSingleton(
  Symbol.for("openclaw.stateDatabaseAdmissionPendingError"),
  () =>
    class extends Error {
      constructor(
        readonly databasePath: string,
        message: string,
      ) {
        super(message);
      }
    },
);

/** Persisted ownership can identify a holder but cannot lend this process maintenance authority. */
export function assertPersistedStateDatabaseAccessAllowed(params: {
  databasePath: string;
  ownerPath: string;
  assertMaintenance: () => void;
}): void {
  const { databasePath, ownerPath, assertMaintenance } = params;
  const unavailable = `OpenClaw state ownership at ${databasePath} could not be verified; retry after maintenance finishes.`;
  let raw: string;
  try {
    raw = fs.readFileSync(ownerPath, "utf8");
  } catch (error) {
    if (extractErrorCode(error) === "ENOENT") {
      return;
    }
    throw new Error(unavailable, { cause: error });
  }
  const owner = parseGatewayLockPayload(raw);
  if (!owner) {
    // Native exclusive creation precedes the payload write; cold admission may wait for publication.
    throw new StateDatabaseAdmissionPendingError(databasePath, unavailable);
  }
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
    throw new Error(unavailable);
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
    throw new Error(unavailable);
  }
  const role = owner.role ?? "gateway";
  if (role === "gateway" || role === "agent-embedded") {
    return;
  }
  if (owner.pid === process.pid) {
    assertMaintenance();
    return;
  }
  const holderSuffix = ` (held by pid ${owner.pid}${owner.createdAt ? `, started ${owner.createdAt}` : ""}; if that process is actually gone, stop it manually and retry)`;
  if (owner.stateOwnerKind === "schema" && owner.role === "sqlite-maintenance") {
    throw new StateDatabaseAdmissionPendingError(
      databasePath,
      `OpenClaw state at ${databasePath} is undergoing offline maintenance; retry when it finishes.${holderSuffix}`,
    );
  }
  throw new Error(
    `OpenClaw state at ${databasePath} is undergoing offline maintenance; retry when it finishes.${holderSuffix}`,
  );
}
