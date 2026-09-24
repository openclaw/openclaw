import { WorktreeRemovalContentionError } from "./registry.js";

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

/** A removal or its claim could not settle; persisted pressure may be stale. */
export class WorktreeRemovalIncompleteError extends Error {
  constructor(
    cause: unknown,
    readonly worktreeId?: string,
  ) {
    super(`Worktree removal could not be reconciled: ${String(cause)}`, { cause });
    this.name = "WorktreeRemovalIncompleteError";
  }
}

/** Preserve the initiating error when releasing its removal claim also fails. */
export function rethrowWorktreeRemovalFailure(error: unknown, abort: () => void): never {
  try {
    abort();
  } catch (cleanupError) {
    throw new WorktreeRemovalIncompleteError(
      new AggregateError([error, cleanupError], `${String(error)}; ${String(cleanupError)}`),
    );
  }
  throw error;
}
