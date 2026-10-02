import { getProcessInstanceStartTime } from "../shared/pid-alive.js";
import { isChildProcessTreeAlive } from "./child-process-tree.js";
import type { CommandProcessIdentity } from "./command-process-custody.types.js";
import { COMMAND_PROCESS_TREE_KILL_GRACE_MS } from "./exec-spawn.js";
import { killProcessTree } from "./kill-tree.js";

/** Join recorded groups after their original in-process cleanup owner was lost. */
export async function settleCommandProcessGroups(
  identities: readonly CommandProcessIdentity[],
): Promise<{ settled: boolean; pids: number[]; reason?: string }> {
  const results = await Promise.all(
    identities.map(async (identity) => {
      const { pid, startedAt } = identity;
      const unresolved = (reason: string) => ({ pid, reason });
      if (
        !Number.isSafeInteger(pid) ||
        pid <= 0 ||
        pid === process.pid ||
        process.platform === "win32"
      ) {
        return unresolved("Process-group custody is unavailable");
      }
      try {
        if (!isChildProcessTreeAlive(identity)) {
          return undefined;
        }
        // An orphaned group has no leader whose start identity can authorize a signal.
        if (startedAt === null || getProcessInstanceStartTime(pid) !== startedAt) {
          return unresolved("Recorded process identity could not be confirmed");
        }
        killProcessTree(pid, { detached: true, force: true });
        const deadline = Date.now() + COMMAND_PROCESS_TREE_KILL_GRACE_MS;
        while (isChildProcessTreeAlive(identity)) {
          const current = getProcessInstanceStartTime(pid);
          if (current !== null && current !== startedAt) {
            return unresolved("Process identity changed during cleanup");
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            return unresolved("Recorded process group remains alive after forced cleanup");
          }
          await new Promise<void>((resolve) => {
            setTimeout(resolve, Math.min(25, remaining));
          });
        }
        return undefined;
      } catch (error) {
        return unresolved(error instanceof Error ? error.message : String(error));
      }
    }),
  );
  const unresolved = results.filter((result) => result !== undefined);
  return {
    settled: unresolved.length === 0,
    pids: [...new Set(unresolved.map(({ pid }) => pid))],
    ...(unresolved.length > 0
      ? { reason: unresolved.map(({ pid, reason }) => `${pid}: ${reason}`).join("; ") }
      : {}),
  };
}
