import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatErrorMessage } from "../../infra/errors.js";
import { OpenClawStateLeaseError } from "../../state/openclaw-state-lease.js";
import { classifyWorktreeRemovalError, WorktreeRemovalIncompleteError } from "./removal-errors.js";
import { WorktreeRemovalContentionError } from "./run-lease-owner.js";
import type { ManagedWorktreeGcResult } from "./types.js";

const MAX_WORKTREE_GC_ISSUES = 64;

export class WorktreeGcProgress {
  readonly result: ManagedWorktreeGcResult = {
    removed: [],
    orphansDeleted: 0,
    snapshotsPruned: 0,
    outcome: "completed",
    issues: [],
    issueCount: 0,
    protectedCount: 0,
    limitsSatisfied: null,
  };
  hasUnreconciledRemoval = false;
  private readonly reportedFailedRemovalIds = new Set<string>();
  private readonly attemptedIds = new Set<string>();

  start(id: string): boolean {
    if (this.attemptedIds.has(id)) {
      return false;
    }
    this.attemptedIds.add(id);
    return true;
  }

  record(
    stage: ManagedWorktreeGcResult["issues"][number]["stage"],
    outcome: ManagedWorktreeGcResult["issues"][number]["outcome"],
    reason: string,
    id?: string,
  ): void {
    if (id !== undefined && (stage === "idle" || stage === "limits")) {
      this.attemptedIds.add(id);
      if (outcome === "failed") {
        this.reportedFailedRemovalIds.add(id);
      }
    }
    this.result.issueCount += 1;
    if (this.result.issues.length < MAX_WORKTREE_GC_ISSUES) {
      this.result.issues.push({
        ...(id === undefined ? {} : { id }),
        stage,
        outcome,
        reason: truncateUtf16Safe(reason, 500),
      });
    }
    if (outcome === "failed") {
      this.result.outcome = "partial";
    } else if (this.result.outcome === "completed") {
      this.result.outcome = "deferred";
    }
  }

  protect(stage: "idle" | "limits", id: string, reason: string): void {
    this.result.protectedCount += 1;
    this.record(stage, "deferred", reason, id);
  }

  recordLimitState(satisfied: boolean, inventoryComplete = true): void {
    this.result.limitsSatisfied = this.hasUnreconciledRemoval
      ? null
      : satisfied
        ? inventoryComplete
          ? true
          : null
        : false;
  }

  error(
    stage: ManagedWorktreeGcResult["issues"][number]["stage"],
    error: unknown,
    id?: string,
  ): void {
    if (
      error instanceof WorktreeRemovalIncompleteError ||
      (error instanceof WorktreeRemovalContentionError && error.removalPending)
    ) {
      this.hasUnreconciledRemoval = true;
    }
    const issueId = error instanceof WorktreeRemovalIncompleteError ? (error.worktreeId ?? id) : id;
    if (
      issueId !== undefined &&
      (stage === "idle" || stage === "limits") &&
      this.reportedFailedRemovalIds.has(issueId)
    ) {
      return;
    }
    const reason = classifyWorktreeRemovalError(error);
    const outcome =
      reason === "busy" ||
      reason === "foreign-lock" ||
      (error instanceof OpenClawStateLeaseError && error.code === "OPENCLAW_STATE_LEASE_HELD")
        ? "deferred"
        : "failed";
    this.record(stage, outcome, `${reason}: ${formatErrorMessage(error)}`, issueId);
  }
}
