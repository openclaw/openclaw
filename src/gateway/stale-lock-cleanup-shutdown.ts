/**
 * Shutdown .jsonl.lock cleanup — unconditional best-effort unlink of all lock
 * files under state/agents/<agentId>/sessions.
 *
 * On graceful shutdown (SIGTERM, SIGINT, explicit close()) removes every
 * `.jsonl.lock` file before the process exits. This is complementary to the
 * per-session write-lock signal handlers, which synchronously call
 * releaseAllLocksSync() — the shutdown sweep catches any stragglers that were
 * acquired between the signal handler's snapshot and process exit.
 *
 * Note: SIGKILL cannot be caught, so stale locks from a killed process are
 * handled by the startup sweep in stale-lock-cleanup-startup.ts.
 *
 * Contract: Hermes 20260617
 */
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("gateway/stale-lock-cleanup-shutdown");

/**
 * Unconditionally removes every `.jsonl.lock` file from all agent session
 * directories. Called during graceful gateway shutdown (best-effort — errors
 * are suppressed so shutdown is never blocked by a failed unlink).
 *
 * Returns the number of lock files removed.
 */
export async function removeAllSessionLocksOnShutdown(
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const stateDir = resolveStateDir(env);
  const agentsDir = path.join(stateDir, "agents");

  let agentEntries: string[];
  try {
    agentEntries = await fs.readdir(agentsDir, { withFileTypes: false });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return 0;
    }
    // Best-effort: do not throw; just skip cleanup.
    log.warn(`shutdown lock cleanup: failed to read agents directory: ${String(err)}`);
    return 0;
  }

  let totalRemoved = 0;

  for (const entry of agentEntries) {
    const sessionsDir = path.join(agentsDir, entry, "sessions");
    let sessionEntries: string[];
    try {
      sessionEntries = await fs.readdir(sessionsDir, { withFileTypes: false });
    } catch {
      // Skip inaccessible or missing sessions directories.
      continue;
    }

    for (const name of sessionEntries) {
      if (!name.endsWith(".jsonl.lock")) {
        continue;
      }
      const lockPath = path.join(sessionsDir, name);
      try {
        await fs.rm(lockPath, { force: true });
        totalRemoved++;
      } catch {
        // Best-effort unlink; if we can't remove it now, move on.
      }
    }
  }

  if (totalRemoved > 0) {
    log.info(`shutdown lock cleanup: removed ${totalRemoved} .jsonl.lock file(s)`);
  }

  return totalRemoved;
}
