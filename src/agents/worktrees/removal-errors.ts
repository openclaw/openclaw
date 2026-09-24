import { WorktreeRemovalContentionError } from "./registry.js";

export class WorktreeBranchMovedError extends Error {}

/** Removal aborted because snapshot loss was not permitted. */
export class WorktreeSnapshotError extends Error {
  readonly snapshotError: string;
  constructor(snapshotError: string, options?: ErrorOptions) {
    super(`worktree snapshot failed; removal aborted: ${snapshotError}`, options);
    this.snapshotError = snapshotError;
  }
}

export type WorktreeRemovalFailureReason =
  | "busy"
  | "foreign-lock"
  | "snapshot-failed"
  | "cleanup-failed";

export class WorktreeRemovalLockError extends Error {
  constructor(
    readonly kind: "busy" | "foreign-lock",
    message: string,
  ) {
    super(message);
    this.name = "WorktreeRemovalLockError";
  }
}

export function classifyWorktreeRemovalError(error: unknown): WorktreeRemovalFailureReason {
  if (error instanceof WorktreeRemovalContentionError) {
    return "busy";
  }
  if (error instanceof WorktreeRemovalLockError) {
    return error.kind;
  }
  if (error instanceof WorktreeSnapshotError) {
    return "snapshot-failed";
  }
  return "cleanup-failed";
}
