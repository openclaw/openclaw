import { DEFAULT_RECOVERY_DELAY_MS } from "../../agents/main-session-recovery/main-session-restart-recovery-shared.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";

export async function waitForRestartRecoveryProgress(params: {
  agentId?: string;
  sessionKey: string;
  ownerRelease?: Promise<void>;
  signal?: AbortSignal;
}): Promise<void> {
  const changed = createDeferredCore();
  const unsubscribe = sessionChanges.subscribe((change) => {
    if (
      "all" in change ||
      (change.sessionKey === params.sessionKey &&
        (!params.agentId || !change.agentId || change.agentId === params.agentId))
    ) {
      changed.resolve();
    }
  });
  // Retry deferred dispatches without spinning; also cover a commit that won
  // just before subscription. Every wake revalidates the session and owner.
  const timer = setTimeout(() => changed.resolve(), DEFAULT_RECOVERY_DELAY_MS);
  timer.unref?.();
  try {
    await racePromiseWithAbortSignal(
      params.ownerRelease ? Promise.race([changed.promise, params.ownerRelease]) : changed.promise,
      params.signal,
    );
  } finally {
    unsubscribe();
    clearTimeout(timer);
  }
}
