import fs from "node:fs";
import {
  classifyGatewayOwnerProcessNamespace,
  GATEWAY_OWNER_HEARTBEAT_STALE_MS,
  readLockHeartbeat,
} from "./gateway-lock-payload.js";
import { isLockOwnerDefinitelyStale } from "./stale-lock-file.js";

/**
 * File-lock recovery also covers pre-namespace (before 2026.10.1) records from supported
 * upgrades on hosts whose PIDs are kernel-global. Linux PID namespaces keep them unknown.
 */
export function classifyGatewayLockProcessNamespace(
  holder:
    | {
        processNamespace?: unknown;
        machineIdentity?: unknown;
        pid?: unknown;
        startTime?: unknown;
      }
    | null
    | undefined,
  lockPath?: string,
): "same" | "dead" | "unknown" {
  if (
    (process.platform === "win32" || process.platform === "darwin") &&
    holder &&
    holder.processNamespace === undefined &&
    lockPath
  ) {
    try {
      // A missing namespace never grants local authority. Only an expired heartbeat
      // plus native proof of process death can retire this legacy file owner.
      if (
        Date.now() - fs.statSync(lockPath).mtimeMs > GATEWAY_OWNER_HEARTBEAT_STALE_MS &&
        isLockOwnerDefinitelyStale({ payload: { pid: holder.pid, starttime: holder.startTime } })
      ) {
        return "dead";
      }
    } catch {
      // Unavailable heartbeat or process observations preserve the owner.
    }
    return "unknown";
  }
  return classifyGatewayOwnerProcessNamespace(holder?.processNamespace, {
    machineIdentity: holder?.machineIdentity,
    readGatewayHeartbeat: lockPath ? () => readLockHeartbeat(lockPath) : undefined,
  });
}
