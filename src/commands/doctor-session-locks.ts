import fs from "node:fs/promises";
import { resolveAgentSessionDirs } from "../agents/session-dirs.js";
import {
  cleanStaleLockFiles,
  resolveSessionWriteLockStaleMs,
  type SessionLockInspection,
  type SessionLockOwnerProcessArgsReader,
  type SessionWriteLockAcquireTimeoutConfig,
} from "../agents/session-write-lock.js";
import { resolveStateDir } from "../config/paths.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";

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

function formatLockLine(lock: SessionLockInspection): string {
  const pidStatus =
    lock.pid === null ? "pid=missing" : `pid=${lock.pid} (${lock.pidAlive ? "alive" : "dead"})`;
  const ageStatus = `age=${formatAge(lock.ageMs)}`;
  const staleStatus = lock.stale
    ? `stale=yes (${lock.staleReasons.join(", ") || "unknown"})`
    : "stale=no";
  const removedStatus = lock.removed ? " [removed]" : "";
  return `- ${shortenHomePath(lock.lockPath)} ${pidStatus} ${ageStatus} ${staleStatus}${removedStatus}`;
}

export type SessionLockHealthIssue = SessionLockInspection;

export async function detectSessionLockHealthIssues(params?: {
  config?: SessionWriteLockAcquireTimeoutConfig;
  env?: NodeJS.ProcessEnv;
  staleMs?: number;
  readOwnerProcessArgs?: SessionLockOwnerProcessArgsReader;
}): Promise<SessionLockHealthIssue[]> {
  const staleMs = params?.staleMs ?? resolveSessionWriteLockStaleMs(params?.config, params?.env);
  const sessionDirs = await resolveAgentSessionDirs(resolveStateDir(params?.env ?? process.env));
  const allLocks: SessionLockInspection[] = [];
  for (const sessionsDir of sessionDirs) {
    const result = await cleanStaleLockFiles({
      sessionsDir,
      staleMs,
      removeStale: false,
      readOwnerProcessArgs: params?.readOwnerProcessArgs,
    });
    allLocks.push(...result.locks);
  }
  return allLocks
    .filter((lock) => lock.stale)
    .toSorted((a, b) => a.lockPath.localeCompare(b.lockPath));
}

export async function repairSessionLockHealthIssues(params?: {
  config?: SessionWriteLockAcquireTimeoutConfig;
  env?: NodeJS.ProcessEnv;
  staleMs?: number;
  lockPaths?: readonly string[];
  readOwnerProcessArgs?: SessionLockOwnerProcessArgsReader;
}): Promise<SessionLockHealthIssue[]> {
  const staleMs = params?.staleMs ?? resolveSessionWriteLockStaleMs(params?.config, params?.env);
  const sessionDirs = await resolveAgentSessionDirs(resolveStateDir(params?.env ?? process.env));
  const scopedLockPaths =
    params?.lockPaths === undefined
      ? undefined
      : new Set(params.lockPaths.map((lockPath) => lockPath.trim()));
  const allLocks: SessionLockInspection[] = [];
  for (const sessionsDir of sessionDirs) {
    const result = await cleanStaleLockFiles({
      sessionsDir,
      staleMs,
      removeStale: false,
      readOwnerProcessArgs: params?.readOwnerProcessArgs,
    });
    for (const lock of result.locks) {
      if (!lock.stale) {
        continue;
      }
      if (scopedLockPaths !== undefined && !scopedLockPaths.has(lock.lockPath)) {
        continue;
      }
      await fs.rm(lock.lockPath, { force: true });
      allLocks.push({ ...lock, removed: true });
    }
  }
  return allLocks.toSorted((a, b) => a.lockPath.localeCompare(b.lockPath));
}

export async function noteSessionLockHealth(params?: {
  shouldRepair?: boolean;
  config?: SessionWriteLockAcquireTimeoutConfig;
  env?: NodeJS.ProcessEnv;
  staleMs?: number;
  readOwnerProcessArgs?: SessionLockOwnerProcessArgsReader;
}) {
  const shouldRepair = params?.shouldRepair === true;
  const staleMs = params?.staleMs ?? resolveSessionWriteLockStaleMs(params?.config, params?.env);
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
      readOwnerProcessArgs: params?.readOwnerProcessArgs,
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
