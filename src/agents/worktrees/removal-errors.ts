import { hasErrnoCode } from "../../infra/errno.js";
import { WorktreeRemovalContentionError, WorktreeRemovalLockError } from "./errors.js";
export { WorktreeRemovalLockError } from "./errors.js";

export function isWorktreePermissionError(error: unknown): boolean {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if (
      hasErrnoCode(cause, "EACCES") ||
      hasErrnoCode(cause, "EPERM") ||
      hasErrnoCode(cause, "permission-denied") ||
      /permission denied/iu.test(cause.message)
    ) {
      return true;
    }
  }
  return false;
}

export type WorktreePreservationReason =
  | "nested-repository"
  | "repository-corrupt"
  | "permission-denied";

/** The code survives the existing Git worker error transport. */
export class WorktreePreservationError extends Error {
  constructor(
    readonly code: WorktreePreservationReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function worktreePreservationReason(error: unknown): WorktreePreservationReason | undefined {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if (hasErrnoCode(cause, "nested-repository")) {
      return "nested-repository";
    }
  }
  if (isWorktreePermissionError(error)) {
    return "permission-denied";
  }
  return isWorktreeRepositoryCorruptionError(error) ? "repository-corrupt" : undefined;
}

export class WorktreeBranchMovedError extends Error {}

export function isWorktreeRepositoryCorruptionError(error: unknown): boolean {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if (
      hasErrnoCode(cause, "repository-corrupt") ||
      /(?:invalid object \d{6} [a-f0-9]{40,64}|not a tree object|(?:loose )?object [^\n]+ (?:is corrupt|is empty)|unable to (?:read|unpack) (?:[a-f0-9]{40,64}|[^\n]*(?:object|tree))|could not fetch [a-f0-9]{40,64} from promisor remote|missing (?:blob|tree|commit) [a-f0-9]{40,64}|packfile [^\n]+ (?:does not match|is truncated))/iu.test(
        cause.message,
      )
    ) {
      return true;
    }
  }
  return false;
}

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
