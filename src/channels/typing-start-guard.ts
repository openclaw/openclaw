/**
 * Typing start guard — prevents the typing callback from executing when the
 * controller is sealed or the run has already completed.
 *
 * Used by TypingController to ensure that late-arriving callbacks (e.g. from
 * tool/block-streaming emitters that don't await their listeners) cannot restart
 * the typing indicator after cleanup has run.
 */

export type TypingStartGuard = {
  /**
   * Run `fn` only if the guard allows it (not sealed, not blocked).
   * If `rethrowOnError` was set, errors from `fn` propagate; otherwise they are swallowed.
   */
  run: (fn: () => Promise<void>) => Promise<void>;
};

/**
 * Create a typing start guard.
 *
 * @param params.isSealed    - Returns true once the typing controller is permanently stopped.
 *                             A sealed controller must never restart typing.
 * @param params.shouldBlock - Returns true while the current model run has completed but the
 *                             controller is not yet cleaned up (run-complete state).
 *                             New typing ticks are skipped in this window.
 * @param params.rethrowOnError - When true, errors thrown by `fn` are re-thrown (useful for
 *                                the initial trigger which needs to surface failures).
 *                                When false/omitted, errors are swallowed.
 */
export function createTypingStartGuard(params: {
  isSealed: () => boolean;
  shouldBlock: () => boolean;
  rethrowOnError?: boolean;
}): TypingStartGuard {
  const { isSealed, shouldBlock, rethrowOnError } = params;

  const run = async (fn: () => Promise<void>): Promise<void> => {
    if (isSealed() || shouldBlock()) {
      return;
    }
    try {
      await fn();
    } catch (err) {
      if (rethrowOnError) {
        throw err;
      }
      // Otherwise swallow — the guard is resilient by default.
    }
  };

  return { run };
}
