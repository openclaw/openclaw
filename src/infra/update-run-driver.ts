import { hostname } from "node:os";
import type { z } from "zod";
import { getFileLockProcessStartTime, isPidDefinitelyDead } from "../shared/pid-alive.js";
import { captureNamespacedStateLeaseProcessOwner } from "./state-lease-process-owner.js";
import type { RecordedUpdateRunDriver, UpdateRunDriverSchema } from "./update-run-driver-schema.js";

export { toUpdateRunDriver, type RecordedUpdateRunDriver } from "./update-run-driver-schema.js";
export type UpdateRunDriver = z.infer<typeof UpdateRunDriverSchema>;

/**
 * A run's own driver also records the boot it ran in, so a later boot of the same
 * host can show it gone. Only Linux and macOS read that; elsewhere it is not captured.
 */
export function readRecordedUpdateRunDriver(): RecordedUpdateRunDriver | undefined {
  const driver = readUpdateRunDriver();
  if (!driver || (process.platform !== "linux" && process.platform !== "darwin")) {
    return driver;
  }
  return { ...driver, namespace: captureNamespacedStateLeaseProcessOwner().namespace };
}

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
