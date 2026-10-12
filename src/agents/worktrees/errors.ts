import {
  collectNestedErrorCandidates,
  extractErrorCode,
} from "@openclaw/normalization-core/error-coercion";
import type { PreservedSessionWorktree } from "../../../packages/gateway-protocol/src/schema/sessions-delete.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import type { WorktreeRegistryPredicate } from "./types.js";

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

export function registryAuthorityChanged(
  kind: WorktreeRegistryPredicate["kind"] | "lifecycle" | "publication",
): Error {
  switch (kind) {
    case "publication":
      return new SessionWorktreeSourceChangedError("GitHub publication worktree authority changed");
    case "snapshot-retirement":
      return new Error("Worktree snapshot retirement identity changed");
    case "exact-snapshot":
      return new Error(
        "Exact-state recovery owner or lifecycle changed; source and snapshot preserved",
      );
    case "exact-owner":
      return new Error("Worktree exact-state owner or lifecycle changed; checkout preserved");
    case "activity":
      return new WorktreeRemovalLockError("busy", "worktree activity changed during cleanup");
    case "session-owner":
      return new SessionWorktreeLifecycleError(
        "Session worktree ownership changed; retry cleanup.",
        "owner-mismatch",
      );
    case "source-record":
      return new SessionWorktreeSourceChangedError(
        "Accepted managed source changed during preparation",
      );
    case "source-owner":
      return new SessionWorktreeSourceChangedError(
        "Spawn parent managed worktree changed; retry from its current session",
      );
    case "projection":
      return new Error("Managed projection owner changed during settlement");
    case "record":
      return new Error(
        "Worktree registry changed during recovery; remaining source and original snapshot preserved",
      );
    default:
      return new WorktreeRemovalContentionError(
        "busy",
        "Worktree owner or binding changed; checkout preserved",
      );
  }
}
