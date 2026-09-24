import type { ManagedWorktreeGcResult } from "./types.js";

export function formatWorktreeGcResult(result: ManagedWorktreeGcResult): string {
  const limits =
    result.limitsSatisfied === null ? "unknown" : result.limitsSatisfied ? "satisfied" : "exceeded";
  const shown = result.issues
    .map((issue) => `${issue.id ?? issue.stage}: ${issue.reason}`)
    .join("; ");
  const omitted = result.issueCount - result.issues.length;
  return (
    [
      `Managed worktree cleanup ${result.outcome}: removed ${result.removed.length}`,
      `deleted ${result.orphansDeleted} orphans`,
      `pruned ${result.snapshotsPruned} snapshots`,
      `protected ${result.protectedCount}`,
      `limits ${limits}`,
      shown && `${shown}${omitted > 0 ? `; plus ${omitted} more` : ""}`,
    ]
      .filter(Boolean)
      .join("; ") + "."
  );
}
