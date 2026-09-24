import { hostname } from "node:os";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getFileLockProcessStartTime, isPidDefinitelyDead } from "../shared/pid-alive.js";

export type StateLeaseProcessOwner = {
  pid: number;
  host: string;
  startedAt: number | null;
};

export function parseStateLeaseProcessOwner(
  payloadJson: string | null,
): StateLeaseProcessOwner | null {
  if (!payloadJson) {
    return null;
  }
  let owner: unknown;
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    owner = isRecord(parsed) ? parsed.owner : null;
  } catch {
    return null;
  }
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
  return { pid, host, startedAt };
}

export function readStateLeaseProcessOwnerStatus(
  owner: StateLeaseProcessOwner | null,
): "live" | "dead" | "unknown" {
  if (!owner || owner.host !== hostname()) {
    return "unknown";
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
