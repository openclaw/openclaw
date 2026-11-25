import {
  sessionChangeScopeAffectsStoredRows,
  sessionChanges,
} from "../sessions/session-row-changes.js";

/** A signal that aborts once a scheduled child's parent stops being current. */
export type ParentResetWatch = Readonly<{
  signal: AbortSignal;
  stop: () => void;
}>;

/**
 * Watches committed session-row changes that can affect the parent row and
 * re-runs the parent's live check on each one. The first failure aborts the
 * signal with that failure, so work outside OpenClaw's tool boundary (a CLI
 * process and its native tools) stops with the parent. Stopping the watch
 * releases the subscription without aborting.
 */
export function watchParentReset(params: {
  parentSessionKey: string;
  assertCurrent: () => void;
}): ParentResetWatch {
  const controller = new AbortController();
  let unsubscribe: (() => void) | undefined;
  const stop = () => {
    unsubscribe?.();
    unsubscribe = undefined;
  };
  unsubscribe = sessionChanges.subscribeFacts((change) => {
    // Only stored-row changes for the parent, or store-wide ones, can end its generation.
    const relevant =
      "all" in change
        ? sessionChangeScopeAffectsStoredRows(change)
        : change.sessionKey === params.parentSessionKey;
    if (!relevant) {
      return;
    }
    try {
      params.assertCurrent();
    } catch (error) {
      stop();
      controller.abort(error);
    }
  });
  return { signal: controller.signal, stop };
}
