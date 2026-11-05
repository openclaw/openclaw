import {
  attachErrorDiagnostic,
  formatErrorMessageForDisplay,
} from "../../infra/error-diagnostics.js";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import { formatUncaughtError } from "../../infra/errors.js";
import { isSqliteLockError } from "../../infra/sqlite-error-diagnostics.js";

/** Terminal worker diagnostics do not participate in recovery decisions. */
export function formatUpdateFinalizationError(error: unknown): string {
  const contention = collectNestedErrorCandidates(error).find(isSqliteLockError);
  if (error && typeof error === "object" && contention instanceof Error) {
    // The worker has already unwound ownership. Retain the actual causal site
    // through aggregate wrappers without changing policy-bearing error fields.
    attachErrorDiagnostic(
      error,
      `SQLite contention call site:\n${formatUncaughtError(contention)}`,
    );
  }
  return formatErrorMessageForDisplay(error);
}
