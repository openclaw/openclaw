import type { ManagedWorktreeGcResult } from "./types.js";

/** One bounded operator summary for the CLI and scheduled cleanup. */
export function formatWorktreeGcResult(result: ManagedWorktreeGcResult): string {
  const issues = result.issues
    .map((issue) => `${issue.stage} ${issue.outcome}=${issue.count}`)
    .join(", ");
  const limits =
    result.limitsSatisfied === null ? "unknown" : result.limitsSatisfied ? "satisfied" : "exceeded";
  return (
    `Cleanup ${result.outcome}: worktrees removed: ${result.removed.length}; ` +
    `orphans deleted: ${result.orphansDeleted}; snapshots pruned: ${result.snapshotsPruned}; ` +
    `protected ${result.protectedCount}; limits ${limits}.` +
    (issues ? ` ${issues}.` : "")
  );
}
