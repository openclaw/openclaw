import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getFileLockProcessStartTime, isPidDefinitelyDead } from "../shared/pid-alive.js";
import {
  classifyGatewayOwnerProcessNamespace,
  GatewayProcessNamespaceSchema,
  type LockPayload,
} from "./gateway-lock-payload.js";

export type StateLeaseProcessOwner = {
  pid: number;
  host: string;
  startedAt: number | null;
  processNamespace?: LockPayload["processNamespace"];
};

export function parseStateLeaseProcessOwner(
  payloadJson: string | null,
): StateLeaseProcessOwner | null {
  const owner = safeParseJsonRecord(payloadJson ?? "")?.owner;
  if (!isRecord(owner)) {
    return null;
  }
  const { pid, host, startedAt } = owner;
  if (
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof host !== "string" ||
    !host ||
    (startedAt !== null &&
      (typeof startedAt !== "number" || !Number.isSafeInteger(startedAt) || startedAt < 0))
  ) {
    return null;
  }
  return {
    pid,
    host,
    startedAt,
    ...(owner.processNamespace === undefined
      ? {}
      : {
          processNamespace:
            GatewayProcessNamespaceSchema.safeParse(owner.processNamespace).data ?? null,
        }),
  };
}

export function readStateLeaseProcessOwnerStatus(
  owner: StateLeaseProcessOwner | null,
  heartbeatAt?: number,
): "live" | "dead" | "unknown" {
  if (!owner) {
    return "unknown";
  }
  const namespace = classifyGatewayOwnerProcessNamespace(owner.processNamespace, {
    ownerHost: owner.host,
    readHeartbeatAt: () => heartbeatAt,
  });
  if (namespace !== "same") {
    return namespace;
  }
  if (isPidDefinitelyDead(owner.pid)) {
    return "dead";
  }
  const currentStartedAt = getFileLockProcessStartTime(owner.pid);
  if (owner.startedAt === null || currentStartedAt === null) {
    return "unknown";
  }
  return currentStartedAt === owner.startedAt ? "live" : "dead";
}
