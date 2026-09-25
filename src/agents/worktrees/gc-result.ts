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
      `retired ${result.orphansRetired} orphan records`,
      ...result.retiredCheckoutPaths.map((checkoutPath) => `preserved checkout: ${checkoutPath}`),
      `pruned ${result.snapshotsPruned} snapshots`,
      `protected ${result.protectedCount}`,
      ...Object.entries(result.protectionReasons).map(([reason, count]) => `${reason}: ${count}`),
      `limits ${limits}`,
      shown && `${shown}${omitted > 0 ? `; plus ${omitted} more` : ""}`,
    ]
      .filter(Boolean)
      .join("; ") + "."
  );
}
