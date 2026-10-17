import { raceWithTimeout } from "@openclaw/retry";
import {
  releaseMainSessionRecoveryOwner,
  type MainSessionRecoveryOwnerLease,
} from "../../agents/main-session-recovery/main-session-recovery-store.js";
import { DEFAULT_RECOVERY_DELAY_MS } from "../../agents/main-session-recovery/main-session-restart-recovery-shared.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { getSessionWorkAdmissionRelease } from "../../sessions/session-lifecycle-admission.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";

const log = createSubsystemLogger("auto-reply/reply-turn-admission");

export async function releaseReplyRecoveryOwner(lease: MainSessionRecoveryOwnerLease | undefined) {
  try {
    return await releaseMainSessionRecoveryOwner(lease);
  } catch (error) {
    log.warn(`failed to release main-session recovery reply owner: ${formatErrorMessage(error)}`);
    // The durable owner schedules exact-token retries. A completed reply must
    // not keep its successor barrier and lifecycle admission until that
    // background repair wins a contested SQLite write.
    return undefined;
  }
}

/** Retained recovery is busy work; only the Gateway owner may reclaim it. */
export async function reconcileOrWaitForReplyRecovery(params: {
  agentId?: string;
  sessionKey: string;
  storePath: string;
  entry: InternalSessionEntry;
  gatewayContext: GatewayRequestContext;
  signal?: AbortSignal;
  assertCurrent: () => void;
}): Promise<void> {
  const { reconcileOrphanedGatewaySessionRecovery } =
    await import("../../gateway/session-recovery-service.js");
  const { resolveSessionWorkerPlacementContext } =
    await import("../../gateway/session-worker-placement-context.js");
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
    commitGuard: params.assertCurrent,
    workerPlacementContext: resolveSessionWorkerPlacementContext(params.gatewayContext),
  });
  if (!recovered) {
    await waitForRestartRecoveryProgress({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      signal: params.signal,
      ownerRelease: getSessionWorkAdmissionRelease({
        scope: params.storePath,
        identities: [params.sessionKey, params.entry.sessionId],
      }),
    });
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
