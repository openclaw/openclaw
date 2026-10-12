import { raceWithTimeout } from "@openclaw/retry";
import { DEFAULT_RECOVERY_DELAY_MS } from "../../agents/main-session-recovery/main-session-restart-recovery-shared.js";
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
  try {
    await raceWithTimeout(
      params.ownerRelease ? Promise.race([changed.promise, params.ownerRelease]) : changed.promise,
      DEFAULT_RECOVERY_DELAY_MS,
      () => undefined,
      { ref: false, signal: params.signal },
    );
  } finally {
    unsubscribe();
  }
}
