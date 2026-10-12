import type { ManagedWorktreeGcReceipt, ManagedWorktreeGcResult } from "./types.js";

export function formatWorktreeGcResult(
  result: ManagedWorktreeGcResult | ManagedWorktreeGcReceipt,
): string {
  const outcome = "state" in result && result.state !== "completed" ? result.state : result.outcome;
  const limits =
    result.limitsSatisfied === null ? "unknown" : result.limitsSatisfied ? "satisfied" : "exceeded";
  const shown = result.issues
    .map((issue) => `${issue.id ?? issue.stage}: ${issue.reason}`)
    .join("; ");
  const omitted = result.issueCount - result.issues.length;
  return (
    [
      `Managed worktree cleanup ${outcome}: removed ${result.removed.length}`,
      `deleted ${result.orphansDeleted} orphans`,
      `retired ${result.orphansRetired} orphan records`,
      ...result.retiredCheckoutPaths.map((checkoutPath) => `preserved checkout: ${checkoutPath}`),
      `pruned ${result.snapshotsPruned} snapshots`,
      result.eligibleCount !== undefined && `eligible ${result.eligibleCount}`,
      result.deferredCount !== undefined && `deferred ${result.deferredCount}`,
      result.failedCount !== undefined && `failed ${result.failedCount}`,
      `protected ${result.protectedCount}`,
      ...Object.entries(result.protectionReasons).map(([reason, count]) => `${reason}: ${count}`),
      `limits ${limits}`,
      ...Object.entries(result.evictions ?? {}).map(([reason, count]) => `${reason}: ${count}`),
      shown && `${shown}${omitted > 0 ? `; plus ${omitted} more` : ""}`,
    ]
      .filter(Boolean)
      .join("; ") + "."
  );
}
