type TypingStartGuard = {
  /** Attempts to start typing and returns the guard outcome instead of throwing by default. */
  run: (start: () => Promise<void> | void) => Promise<"started" | "skipped" | "failed" | "tripped">;
  /** Clears failure count and trip state after a successful recovery or test reset. */
  reset: () => void;
  /** Returns whether repeated failures have permanently blocked starts until reset. */
  isTripped: () => boolean;
};

/** Creates a guard that prevents typing-start retries after seal, block, or repeated failure. */
export function createTypingStartGuard(params: {
  /** Returns true when the owning turn/session is sealed and typing should not start. */
  isSealed: () => boolean;
  /** Optional dynamic block predicate for channel-specific state. */
  shouldBlock?: () => boolean;
  /** Error sink for failed typing starts. */
  onStartError?: (err: unknown) => void;
  /** Failure count that trips the guard; omitted means never trip by count. */
  maxConsecutiveFailures?: number;
  /** Callback invoked once when the failure threshold trips. */
  onTrip?: () => void;
  /** Whether start errors should propagate instead of being converted to "failed". */
  rethrowOnError?: boolean;
}): TypingStartGuard {
  const maxConsecutiveFailures =
    typeof params.maxConsecutiveFailures === "number" && params.maxConsecutiveFailures > 0
      ? Math.floor(params.maxConsecutiveFailures)
      : undefined;
  let consecutiveFailures = 0;
  let tripped = false;

  const isBlocked = () => {
    // Sealed turns and tripped breakers both fail closed before adapter state
    // is touched; shouldBlock handles transient channel-specific suppression.
    if (params.isSealed()) {
      return true;
    }
    if (tripped) {
      return true;
    }
    return params.shouldBlock?.() === true;
  };

  const run: TypingStartGuard["run"] = async (start) => {
    if (isBlocked()) {
      // "skipped" covers pre-existing blockers; callers should not treat it as a fresh adapter
      // failure because no start attempt was made.
      return "skipped";
    }
    try {
      await start();
      // A successful refresh proves the adapter recovered, so only consecutive
      // failures count toward the breaker threshold.
      consecutiveFailures = 0;
      return "started";
    } catch (err) {
      consecutiveFailures += 1;
      params.onStartError?.(err);
      if (params.rethrowOnError) {
        throw err;
      }
      if (maxConsecutiveFailures && consecutiveFailures >= maxConsecutiveFailures) {
        // Once tripped, future calls skip without touching the adapter until reset clears state.
        tripped = true;
        params.onTrip?.();
        return "tripped";
      }
      return "failed";
    }
  };

  return {
    run,
    reset: () => {
      consecutiveFailures = 0;
      tripped = false;
    },
    isTripped: () => tripped,
  };
}
