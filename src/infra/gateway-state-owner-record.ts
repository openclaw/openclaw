import fs from "node:fs";
import { isMainThread } from "node:worker_threads";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { parseGatewayLockPayload } from "./gateway-lock-payload.js";
import { isLockOwnerDefinitelyStale } from "./stale-lock-file.js";

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
  if (
    isLockOwnerDefinitelyStale({
      payload: { pid: owner.pid, starttime: owner.startTime },
    })
  ) {
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
  if (owner.stateOwnerKind === "schema" && owner.role === "sqlite-maintenance") {
    throw new StateDatabaseAdmissionPendingError(
      databasePath,
      `OpenClaw state at ${databasePath} is undergoing offline maintenance; retry when it finishes.`,
    );
  }
  throw new Error(
    `OpenClaw state at ${databasePath} is undergoing offline maintenance; retry when it finishes.`,
  );
}
