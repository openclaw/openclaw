import { raceWithTimeout } from "@openclaw/retry";
import { DEFAULT_RECOVERY_DELAY_MS } from "../../agents/main-session-recovery/main-session-restart-recovery-shared.js";
import { SessionWorkStartChangedError } from "../../config/sessions/lifecycle.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  captureSessionTarget,
  getCompetingSessionWorkAdmissionRelease,
} from "../../sessions/session-controller.lifecycle.js";
import { reserveSessionControllerClaimPredecessor } from "../../sessions/session-controller.mailbox-predecessor.js";
import {
  retireSessionControllerInput,
  type SessionControllerMailboxClaim,
} from "../../sessions/session-controller.mailbox.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";

/** Retained recovery is busy work; only the Gateway owner may reclaim it. */
export async function reconcileOrWaitForReplyRecovery(params: {
  agentId?: string;
  sessionKey: string;
  storePath: string;
  entry: InternalSessionEntry;
  gatewayContext: GatewayRequestContext;
  signal?: AbortSignal;
  assertCurrent: () => void;
  claim?: SessionControllerMailboxClaim;
}): Promise<void> {
  const { reconcileOrphanedGatewaySessionRecovery } =
    await import("../../gateway/session-recovery-source.js");
  const { resolveSessionWorkerPlacementContext } =
    await import("../../gateway/session-worker-placement-context.js");
  const signal =
    params.claim && params.signal
      ? AbortSignal.any([params.claim.abortController.signal, params.signal])
      : (params.claim?.abortController.signal ?? params.signal);
  const assertCurrent = () => {
    signal?.throwIfAborted();
    params.assertCurrent();
  };
  assertCurrent();
  // Yield only this pre-execution input. The unbound predecessor keeps later
  // input queued while the Gateway owner decides whether recovery is orphaned.
  const handoff = params.claim
    ? reserveSessionControllerClaimPredecessor(params.claim, {
        policy: { mode: "followup" },
        target: captureSessionTarget({
          storeScope: params.storePath,
          sessionKey: params.sessionKey,
          incarnation: params.entry.sessionId,
          agentId: params.agentId,
        }),
        adapter: { signal },
      })
    : undefined;
  let restored = true;
  try {
    const recovered = await reconcileOrphanedGatewaySessionRecovery({
      cfg: params.gatewayContext.getRuntimeConfig(),
      entry: params.entry,
      target: {
        agentId: params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey),
        storePath: params.storePath,
        canonicalKey: params.sessionKey,
        storeKeys: [params.sessionKey],
      },
      authorizedPluginId: getPluginRuntimeGatewayRequestScope()?.pluginId,
      commitGuard: assertCurrent,
      workerPlacementContext: resolveSessionWorkerPlacementContext(params.gatewayContext),
    });
    if (!recovered) {
      await waitForRestartRecoveryProgress({
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        signal,
        ownerRelease: getCompetingSessionWorkAdmissionRelease({
          scope: params.storePath,
          identities: [params.sessionKey, params.entry.sessionId],
          beforeClaim: params.claim,
        }),
      });
    }
  } finally {
    if (handoff) {
      retireSessionControllerInput(handoff.input);
      restored = await handoff.restored;
    }
  }
  assertCurrent();
  if (!restored) {
    throw new SessionWorkStartChangedError("Session changed while waiting for recovery.");
  }
}

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
