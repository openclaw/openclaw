import { isDeepStrictEqual } from "node:util";
import { raceWithTimeout } from "@openclaw/retry";
import { isForegroundRecoveryInputCurrent } from "../../agents/main-session-recovery/main-session-recovery-state-transitions.js";
import {
  releaseMainSessionRecoveryOwner,
  type MainSessionRecoveryOwnerLease,
} from "../../agents/main-session-recovery/main-session-recovery-store.js";
import type {
  MainSessionRecoveryAuthorityHold,
  MainSessionRecoveryCurrentInput,
} from "../../agents/main-session-recovery/main-session-restart-dispatch.types.js";
import { DEFAULT_RECOVERY_DELAY_MS } from "../../agents/main-session-recovery/main-session-restart-recovery-shared.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { ReplyTurnKind } from "./reply-run-registry.js";
import { rejectLifecycleInvalidatedWork } from "./reply-turn-admission-errors.js";

const log = createSubsystemLogger("auto-reply/reply-turn-admission");

export function prepareForegroundRestartRecoveryWait(
  scope: { agentId?: string; sessionKey: string; upstreamAbortSignal?: AbortSignal },
  readRuntime: () => GatewayRecoveryRuntime | undefined,
  assertRuntimeCurrent: (
    runtime: GatewayRecoveryRuntime | undefined,
    action: "waiting for",
  ) => void,
): (ownerRelease?: Promise<void>) => Promise<void> {
  return async (ownerRelease) => {
    const runtime = readRuntime();
    await waitForRestartRecoveryProgress({
      agentId: scope.agentId,
      sessionKey: scope.sessionKey,
      signal: scope.upstreamAbortSignal,
      ownerRelease,
    });
    assertRuntimeCurrent(runtime, "waiting for");
  };
}

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

export function prepareRestartRecoveryCurrentInputClaim(
  input: MainSessionRecoveryCurrentInput | undefined,
  kind: ReplyTurnKind,
  readEntry: () => InternalSessionEntry | undefined,
  assertRequestCurrent: (() => void) | undefined,
  rejectChanged: () => never,
): (() => void) | undefined {
  if (!input) {
    return undefined;
  }
  return () => {
    input.assertCurrent();
    assertRequestCurrent?.();
    const entry = readEntry();
    if (kind !== "visible" || !entry || !isForegroundRecoveryInputCurrent(entry, input.intent)) {
      rejectChanged();
    }
  };
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

/** A structural authority hold cannot settle by waiting; transient owners still can. */
export function resolveRestartRecoveryForegroundDisposition(params: {
  outcome: "deferred" | "failed" | MainSessionRecoveryAuthorityHold;
  entry: InternalSessionEntry;
  kind: ReplyTurnKind;
  sessionKey: string;
  assertRequestCurrent?: () => void;
}): "retry" | "wait" | "skip" {
  const hold = params.outcome;
  if (typeof hold === "object") {
    // Never apply a refusal from an older recovery observation to changed work.
    if (
      hold.observation.sessionId !== params.entry.sessionId ||
      hold.observation.cycleId !== params.entry.mainRestartRecovery?.cycleId ||
      hold.observation.revision !== params.entry.mainRestartRecovery.revision ||
      !isDeepStrictEqual(hold.source, {
        mainRestartRecovery: params.entry.mainRestartRecovery,
        restartRecoveryGoal: params.entry.restartRecoveryGoal,
        restartRecoveryDeliverySourceRunId: params.entry.restartRecoveryDeliverySourceRunId,
        restartRecoveryDeliveryRunId: params.entry.restartRecoveryDeliveryRunId,
        lifecycleRunId: params.entry.lifecycleRunId,
      })
    ) {
      return "retry";
    }
    params.assertRequestCurrent?.();
    rejectLifecycleInvalidatedWork({
      kind: params.kind,
      workStartInvalidated: true,
      message: `Session "${params.sessionKey}" cannot recover interrupted work without its original accepted authority (${hold.reason}). Review the interrupted work and restore its original authority before continuing. The Goal and pending inputs are preserved.`,
    });
  }
  if (params.kind === "queued_followup") {
    return "skip";
  }
  if (hold === "failed") {
    throw new Error(`Restart recovery failed: ${params.sessionKey}. See Gateway logs.`);
  }
  return "wait";
}
