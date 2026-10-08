import {
  collectNestedErrorCandidates,
  extractErrorCode,
} from "@openclaw/normalization-core/error-coercion";
import type { PreservedSessionWorktree } from "../../../packages/gateway-protocol/src/schema/sessions-delete.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";

/** Worker and child-process uncertainty both retain artifacts until native settlement. */
export function hasWorktreeUnknownOutcome(error: unknown): boolean {
  return (
    hasCommandProcessCleanupError(error) ||
    collectNestedErrorCandidates(error).some(
      (cause) => extractErrorCode(cause) === "outcome-unknown",
    )
  );
}

export class WorktreeRepositoryError extends Error {
  readonly reason?: "unborn";

  constructor(message: string, options?: ErrorOptions & { reason?: "unborn" }) {
    super(message, options);
    this.name = "WorktreeRepositoryError";
    this.reason = options?.reason;
  }
}

export class WorktreeRemovalContentionError extends Error {
  constructor(
    readonly kind: "busy" | "finalized",
    message: string,
    readonly blockedByRun?: { worktreeId: string; pid: number },
  ) {
    super(message);
    this.name = "WorktreeRemovalContentionError";
  }
}

export class WorktreeRemovalLockError extends Error {
  constructor(
    readonly kind: "busy" | "foreign-lock",
    message: string,
  ) {
    super(message);
    this.name = "WorktreeRemovalLockError";
  }
}

export class SessionWorktreeSourceChangedError extends Error {}

export class SessionWorktreeLifecycleError extends Error {
  constructor(
    message: string,
    readonly reason: PreservedSessionWorktree["reason"] | "restore-failed" | "session-changed",
  ) {
    super(message);
  }
}

export class WorktreePendingContentionError extends Error {
  constructor(readonly worktreeId: string) {
    super("Managed worktree creation is pending; waiting for its checkout owner");
    this.name = "WorktreePendingContentionError";
  }
}
