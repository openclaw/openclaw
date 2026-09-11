import { hostname } from "node:os";
import { getFileLockProcessStartTime, isPidDefinitelyDead } from "../shared/pid-alive.js";
import { UNPROTECTED_GATEWAY_UPDATE_ADVISORY, type UpdateRunRecord } from "./update-run-record.js";

export type UpdateRunDriver = {
  host: string;
  pid: number;
  startIdentity: string;
};

export function sameUpdateRunDriver(left: UpdateRunDriver, right: UpdateRunDriver): boolean {
  return (
    left.host === right.host && left.pid === right.pid && left.startIdentity === right.startIdentity
  );
}

export function readUpdateRunDriver(pid = process.pid): UpdateRunDriver | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return undefined;
  }
  const host = hostname();
  const startedAt = getFileLockProcessStartTime(pid);
  if (
    !host ||
    host.length > 255 ||
    startedAt === null ||
    !Number.isSafeInteger(startedAt) ||
    startedAt < 0
  ) {
    return undefined;
  }
  return { host, pid, startIdentity: String(startedAt) };
}

export function inspectUpdateRunDriver(driver: UpdateRunDriver): "alive" | "dead" | "unknown" {
  // A PID on another host says nothing about this driver's lifetime.
  if (driver.host !== hostname()) {
    return "unknown";
  }
  if (isPidDefinitelyDead(driver.pid)) {
    return "dead";
  }
  const startedAt = getFileLockProcessStartTime(driver.pid);
  if (startedAt === null) {
    return "unknown";
  }
  // A reused PID proves the recorded driver exited. An identical identity after
  // a reboot remains conservatively live; identity coincidence never revokes it.
  return String(startedAt) === driver.startIdentity ? "alive" : "dead";
}

export function requireUnprotectedGatewayUpdate(record: UpdateRunRecord | undefined) {
  const declaration = record?.origin.unprotectedGatewayUpdate;
  if (
    !record ||
    !declaration ||
    record.status !== "running" ||
    record.trigger === "cli" ||
    record.target.kind !== "git" ||
    record.origin.updateRecoveryCapture ||
    inspectUpdateRunDriver(declaration.owner) !== "alive"
  ) {
    throw new Error(
      "Unprotected Gateway update requires its live, explicitly declared parent run.",
    );
  }
  return { record, declaration };
}

/** Only the serving RPC driver may declare this intentionally unprotected update. */
export function declareUnprotectedGatewayUpdateRecord(record: UpdateRunRecord): void {
  const owner = readUpdateRunDriver();
  if (
    !owner ||
    !record.origin.driver ||
    !sameUpdateRunDriver(record.origin.driver, owner) ||
    record.status !== "running" ||
    record.trigger === "cli" ||
    record.target.kind !== "git" ||
    record.verification.pid !== owner.pid ||
    record.verification.serviceRunning !== true ||
    record.origin.updateRecoveryCapture ||
    record.origin.unprotectedGatewayUpdate
  ) {
    throw new Error("Only the admitted Gateway driver may declare an unprotected Git update.");
  }
  record.origin.unprotectedGatewayUpdate = { owner };
  record.origin.nextAction = UNPROTECTED_GATEWAY_UPDATE_ADVISORY;
}

export function bindUnprotectedGatewayUpdateFinalizerRecord(record: UpdateRunRecord): void {
  const self = readUpdateRunDriver();
  const directParent = readUpdateRunDriver(process.ppid);
  const { declaration } = requireUnprotectedGatewayUpdate(record);
  if (
    !self ||
    !directParent ||
    !sameUpdateRunDriver(declaration.owner, directParent) ||
    !record.origin.driver ||
    !sameUpdateRunDriver(record.origin.driver, directParent) ||
    (declaration.finalizer && !sameUpdateRunDriver(declaration.finalizer, self))
  ) {
    throw new Error("Unprotected Gateway finalizer is not the declared owner's child.");
  }
  record.origin.unprotectedGatewayUpdate = { ...declaration, finalizer: self };
}
