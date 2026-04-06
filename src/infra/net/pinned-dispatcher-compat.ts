import type { PinnedDispatcherPolicy } from "./ssrf.js";

type ErrorWithCause = {
  code?: unknown;
  message?: unknown;
  cause?: unknown;
};

function* iterateErrorCauseChain(error: unknown): Generator<ErrorWithCause> {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    yield current as ErrorWithCause;
    current = (current as ErrorWithCause).cause;
  }
}

export function canBypassPinnedDispatcherForCompatibility(
  policy?: PinnedDispatcherPolicy,
): boolean {
  return !policy || policy.mode === "direct";
}

export function isPinnedDispatcherRuntimeCompatibilityError(error: unknown): boolean {
  for (const candidate of iterateErrorCauseChain(error)) {
    const message = typeof candidate.message === "string" ? candidate.message : "";
    if (
      candidate.code === "UND_ERR_INVALID_ARG" &&
      message.toLowerCase().includes("onrequeststart")
    ) {
      return true;
    }
  }
  return false;
}
