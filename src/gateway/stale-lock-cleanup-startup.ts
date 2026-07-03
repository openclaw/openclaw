/**
 * Startup stale .jsonl.lock cleanup.
 *
 * On gateway startup, sweeps lock files older than 120s from all agent session
 * directories under state/agents/<agentId>/sessions. This covers the case where a
 * previous gateway process was killed with SIGKILL (or any other uncaught
 * signal) and left stale lock files behind.
 *
 * Contract: Hermes 20260617
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  cleanStaleLockFiles,
  type SessionLockOwnerProcessArgsReader,
} from "../agents/session-write-lock.js";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("gateway/stale-lock-cleanup-startup");

/** Lock files older than this threshold are removed on startup. */
const STALE_LOCK_CLEANUP_AGE_MS = 120_000;

/**
 * Sweep stale `.jsonl.lock` files from all agent session directories on
 * gateway startup. Returns the count of cleaned (removed) lock files.
 *
 * Errors for individual agent directories are silently swallowed so a single
 * inaccessible directory never prevents gateway startup.
 *
 * Delegates staleness/ownership checks (dead pid, recycled pid, non-OpenClaw
 * owner) to the shared `cleanStaleLockFiles` helper, so locks actively held
 * by another live OpenClaw process are left alone — this is the safety guard
 * against removing locks out from under a still-running process.
 */
export async function sweepStaleSessionLocksOnStartup(
  env: NodeJS.ProcessEnv = process.env,
  opts: { readOwnerProcessArgs?: SessionLockOwnerProcessArgsReader } = {},
): Promise<number> {
  const stateDir = resolveStateDir(env);
  const agentsDir = path.join(stateDir, "agents");

  let agentEntries: string[];
  try {
    agentEntries = await fs.readdir(agentsDir, { withFileTypes: false });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      // No agents directory yet — nothing to sweep.
      return 0;
    }
    log.warn(`startup lock sweep: failed to read agents directory: ${String(err)}`);
    return 0;
  }

  let totalCleaned = 0;

  for (const entry of agentEntries) {
    const sessionsDir = path.join(agentsDir, entry, "sessions");
    try {
      const result = await cleanStaleLockFiles({
        sessionsDir,
        staleMs: STALE_LOCK_CLEANUP_AGE_MS,
        removeStale: true,
        nowMs: Date.now(),
        readOwnerProcessArgs: opts.readOwnerProcessArgs,
        log: {
          warn: (message) => log.warn(message),
        },
      });
      totalCleaned += result.cleaned.length;
    } catch {
      // If a particular agent's sessions directory doesn't exist or is
      // inaccessible, skip it — the gateway can still start fine.
    }
  }

  if (totalCleaned > 0) {
    log.info(`startup lock sweep: removed ${totalCleaned} stale .jsonl.lock file(s)`);
  }

  return totalCleaned;
}
