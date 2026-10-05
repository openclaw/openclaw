import type { PreservedSessionWorktree } from "../../../packages/gateway-protocol/src/schema/sessions-delete.js";

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
