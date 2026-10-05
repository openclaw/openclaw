import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";

export class UpdateCommandRecoveryPendingError extends Error {
  override name = "UpdateCommandRecoveryPendingError";
}

/** Unresolved recipe effects must retain custody even after their child processes have settled. */
export class UpdateCommandRecipeReconciliationPendingError extends UpdateCommandRecoveryPendingError {
  override name = "UpdateCommandRecipeReconciliationPendingError";
}

/** A semantic pending result retains original custody without inventing a process-cleanup failure. */
export function hasUpdateCommandRecipeReconciliationPendingError(error: unknown): boolean {
  return collectNestedErrorCandidates(error).some(
    (candidate) => candidate instanceof UpdateCommandRecipeReconciliationPendingError,
  );
}

export function isPostUpdatePending(
  error: unknown,
  params: { originalManagedServiceRuntime?: unknown; opts: { recipe?: unknown } },
): boolean {
  return Boolean(
    (params.originalManagedServiceRuntime || params.opts.recipe) &&
    (error instanceof UpdateCommandRecoveryPendingError ||
      hasUpdateCommandRecipeReconciliationPendingError(error)),
  );
}
