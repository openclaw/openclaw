import { resolveAgentSessionDirs } from "../agents/session-dirs.js";
import { cleanStaleLockFiles, type SessionLockInspection } from "../agents/session-write-lock.js";
import { resolveStateDir } from "../config/paths.js";
import { formatDurationCompact } from "../infra/format-time/format-duration.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";

const DEFAULT_STALE_MS = 30 * 60 * 1000;

function formatLockLine(lock: SessionLockInspection): string {
  const pidStatus =
    lock.pid === null ? "pid=missing" : `pid=${lock.pid} (${lock.pidAlive ? "alive" : "dead"})`;
  const ageText = lock.ageMs === null ? "unknown" : (formatDurationCompact(lock.ageMs) ?? "0s");
  const ageStatus = `age=${ageText}`;
  const staleStatus = lock.stale
    ? `stale=yes (${lock.staleReasons.join(", ") || "unknown"})`
    : "stale=no";
  const removedStatus = lock.removed ? " [removed]" : "";
  return `- ${shortenHomePath(lock.lockPath)} ${pidStatus} ${ageStatus} ${staleStatus}${removedStatus}`;
}

export async function noteSessionLockHealth(params?: { shouldRepair?: boolean; staleMs?: number }) {
  const shouldRepair = params?.shouldRepair === true;
  const staleMs = params?.staleMs ?? DEFAULT_STALE_MS;
  let sessionDirs: string[] = [];
  try {
    sessionDirs = await resolveAgentSessionDirs(resolveStateDir(process.env));
  } catch (err) {
    note(`- Failed to inspect session lock files: ${String(err)}`, "Session locks");
    return;
  }

  if (sessionDirs.length === 0) {
    return;
  }

  const allLocks: SessionLockInspection[] = [];
  for (const sessionsDir of sessionDirs) {
    const result = await cleanStaleLockFiles({
      sessionsDir,
      staleMs,
      removeStale: shouldRepair,
    });
    allLocks.push(...result.locks);
  }

  if (allLocks.length === 0) {
    return;
  }

  const staleCount = allLocks.filter((lock) => lock.stale).length;
  const removedCount = allLocks.filter((lock) => lock.removed).length;
  const lines: string[] = [
    `- Found ${allLocks.length} session lock file${allLocks.length === 1 ? "" : "s"}.`,
    ...allLocks.toSorted((a, b) => a.lockPath.localeCompare(b.lockPath)).map(formatLockLine),
  ];

  if (staleCount > 0 && !shouldRepair) {
    lines.push(`- ${staleCount} lock file${staleCount === 1 ? " is" : "s are"} stale.`);
    lines.push('- Run "openclaw doctor --fix" to remove stale lock files automatically.');
  }
  if (shouldRepair && removedCount > 0) {
    lines.push(
      `- Removed ${removedCount} stale session lock file${removedCount === 1 ? "" : "s"}.`,
    );
  }

  note(lines.join("\n"), "Session locks");
}
