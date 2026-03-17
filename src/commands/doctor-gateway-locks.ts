import { inspectGatewayLock, type GatewayLockInspection } from "../infra/gateway-lock.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";

const DEFAULT_STALE_MS = 30 * 1000;

function formatAge(ageMs: number | null): string {
  if (ageMs === null) {
    return "unknown";
  }
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return `${minutes}m${remainingSeconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h${remainingMinutes}m`;
}

function formatGatewayLockLine(lock: GatewayLockInspection): string {
  const pidStatus =
    lock.pid === null ? "pid=missing" : `pid=${lock.pid} (${lock.pidAlive ? "alive" : "dead"})`;
  const ageStatus = `age=${formatAge(lock.ageMs)}`;
  const staleStatus = lock.stale
    ? `stale=yes (${lock.staleReasons.join(", ") || "unknown"})`
    : "stale=no";
  const removedStatus = lock.removed ? " [removed]" : "";
  return `- ${shortenHomePath(lock.lockPath)} ${pidStatus} ${ageStatus} ${staleStatus}${removedStatus}`;
}

export async function noteGatewayLockHealth(params?: { shouldRepair?: boolean; staleMs?: number }) {
  const shouldRepair = params?.shouldRepair === true;
  const staleMs = params?.staleMs ?? DEFAULT_STALE_MS;
  let inspection: GatewayLockInspection | null = null;
  try {
    inspection = await inspectGatewayLock({
      staleMs,
      removeStale: shouldRepair,
    });
  } catch (err) {
    note(`- Failed to inspect gateway lock: ${String(err)}`, "Gateway lock");
    return;
  }

  if (!inspection) {
    return;
  }

  const lines = ["- Found gateway lock file.", formatGatewayLockLine(inspection)];
  if (inspection.stale && !shouldRepair) {
    lines.push("- Gateway lock is stale.");
    lines.push('- Run "openclaw doctor --fix" to remove the stale gateway lock automatically.');
  }
  if (shouldRepair && inspection.removed) {
    lines.push("- Removed stale gateway lock file.");
  }
  note(lines.join("\n"), "Gateway lock");
}
