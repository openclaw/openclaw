type TypingStartGuard = {
  run: (start: () => Promise<void> | void) => Promise<"started" | "skipped" | "failed" | "tripped">;
  reset: () => void;
  isTripped: () => boolean;
};

/**
 * Guard repeated typing-start attempts so sealed replies and failing channel
 * APIs stop scheduling more typing work.
 */
export function createTypingStartGuard(params: {
  isSealed: () => boolean;
  shouldBlock?: () => boolean;
  onStartError?: (err: unknown) => void;
  maxConsecutiveFailures?: number;
  onTrip?: () => void;
  rethrowOnError?: boolean;
}): TypingStartGuard {
  const maxConsecutiveFailures =
    typeof params.maxConsecutiveFailures === "number" && params.maxConsecutiveFailures > 0
      ? Math.floor(params.maxConsecutiveFailures)
      : undefined;
  let consecutiveFailures = 0;
  let tripped = false;

  // The sealed/tripped checks are intentionally evaluated at each start call;
  // typing indicators may be scheduled after the reply has already completed.
  const isBlocked = () => {
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
      return "skipped";
    }
    try {
      await start();
      consecutiveFailures = 0;
      return "started";
    } catch (err) {
      consecutiveFailures += 1;
      params.onStartError?.(err);
      if (params.rethrowOnError) {
        throw err;
      }
      // A tripped guard is sticky until reset so noisy channel failures do not
      // keep producing errors for the same reply lifecycle.
      if (maxConsecutiveFailures && consecutiveFailures >= maxConsecutiveFailures) {
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
