export {
  collectNestedErrorCandidates,
  extractErrorCodeOrErrno,
} from "@openclaw/normalization-core/error-coercion";

/** Retained errors must not keep callers alive through V8's lazy stack frames. */
export function materializeErrorStack(failure: unknown): void {
  let error = failure;
  const seen = new Set<Error>();
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error);
    try {
      error.stack = String(error.stack);
    } catch {
      // The setter releases private frames even when a custom formatter throws.
      error.stack = "Stack trace unavailable: custom formatter failed";
    }
    error = error.cause;
  }
}
