/**
 * Foreground reply freshness fence: newer foreground turns suppress stale
 * visible deliveries from older turns on the same session target, with a
 * bounded settlement wait so completed replies never park for a newer turn's
 * whole runtime.
 */
import { normalizeChatType } from "../channels/chat-type.js";
import { isOutboundDeliveryError } from "../infra/outbound/deliver-types.js";
import { hasOutboundReplyContent } from "../plugin-sdk/reply-payload.js";
import type { FinalizedMsgContext } from "./templating.js";
import type { ReplyPayload } from "./types.js";

type ForegroundReplyFenceState = {
  generation: number;
  visibleDeliveryGeneration: number;
  activeDispatches: number;
  activeGenerations: Map<number, number>;
  suspendedGenerations: Set<number>;
  waiters: Set<() => void>;
};

type ForegroundReplyFenceSnapshot = {
  key: string;
  generation: number;
  state: ForegroundReplyFenceState;
};

const foregroundReplyFenceByKey = new Map<string, ForegroundReplyFenceState>();

function normalizeForegroundReplyFencePart(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveForegroundReplyFenceKey(finalized: FinalizedMsgContext): string | undefined {
  const sessionKey = normalizeForegroundReplyFencePart(finalized.SessionKey);
  const channel =
    normalizeForegroundReplyFencePart(finalized.OriginatingChannel) ??
    normalizeForegroundReplyFencePart(finalized.Surface) ??
    normalizeForegroundReplyFencePart(finalized.Provider);
  const target =
    normalizeForegroundReplyFencePart(finalized.OriginatingTo) ??
    normalizeForegroundReplyFencePart(finalized.NativeChannelId) ??
    normalizeForegroundReplyFencePart(finalized.From) ??
    normalizeForegroundReplyFencePart(finalized.To);

  if (!sessionKey || !channel || !target) {
    return undefined;
  }

  // JSON keeps the composite key unambiguous across account/session/channel ids.
  return JSON.stringify([
    "foreground",
    channel,
    normalizeForegroundReplyFencePart(finalized.AccountId) ?? "default",
    sessionKey,
    normalizeChatType(finalized.ChatType) ?? "unknown",
    target,
  ]);
}

export function beginForegroundReplyFence(
  finalized: FinalizedMsgContext,
): ForegroundReplyFenceSnapshot | undefined {
  const key = resolveForegroundReplyFenceKey(finalized);
  if (!key) {
    return undefined;
  }
  const state = foregroundReplyFenceByKey.get(key) ?? {
    generation: 0,
    visibleDeliveryGeneration: 0,
    activeDispatches: 0,
    activeGenerations: new Map<number, number>(),
    suspendedGenerations: new Set<number>(),
    waiters: new Set<() => void>(),
  };
  // Generation ordering lets newer foreground replies suppress stale visible deliveries.
  state.generation += 1;
  state.activeDispatches += 1;
  state.activeGenerations.set(
    state.generation,
    (state.activeGenerations.get(state.generation) ?? 0) + 1,
  );
  foregroundReplyFenceByKey.set(key, state);
  return {
    key,
    generation: state.generation,
    state,
  };
}

function notifyForegroundReplyFenceWaiters(state: ForegroundReplyFenceState): void {
  const waiters = [...state.waiters];
  state.waiters.clear();
  for (const resolve of waiters) {
    resolve();
  }
}

export function setForegroundReplyFenceAdmissionWaiting(
  snapshot: ForegroundReplyFenceSnapshot | undefined,
  waiting: boolean,
): void {
  if (!snapshot) {
    return;
  }
  const state = foregroundReplyFenceByKey.get(snapshot.key);
  if (state !== snapshot.state) {
    return;
  }
  if (waiting) {
    if (state.activeGenerations.delete(snapshot.generation)) {
      state.suspendedGenerations.add(snapshot.generation);
    }
  } else if (state.suspendedGenerations.delete(snapshot.generation)) {
    state.activeGenerations.set(snapshot.generation, 1);
  }
  notifyForegroundReplyFenceWaiters(state);
}

function hasNewerActiveForegroundReplyFenceGeneration(
  state: ForegroundReplyFenceState,
  generation: number,
): boolean {
  for (const [activeGeneration, count] of state.activeGenerations) {
    if (activeGeneration > generation && count > 0) {
      return true;
    }
  }
  return false;
}

/**
 * Absolute budget for holding a delivery behind newer active generations. An
 * admitted newer turn can run for many minutes without a visible delivery;
 * parking a completed reply that long delays or strands it (and everything
 * queued behind it on the same dispatch).
 */
export const FOREGROUND_REPLY_FENCE_WAIT_TIMEOUT_MS = 20_000;

export async function shouldCancelForegroundReplyDelivery(
  snapshot: ForegroundReplyFenceSnapshot | undefined,
  waitDeadlineMs: number,
): Promise<boolean> {
  if (!snapshot) {
    return false;
  }
  while (true) {
    const state = foregroundReplyFenceByKey.get(snapshot.key);
    if (!state) {
      return false;
    }
    if (state.visibleDeliveryGeneration > snapshot.generation) {
      return true;
    }
    if (!hasNewerActiveForegroundReplyFenceGeneration(state, snapshot.generation)) {
      return false;
    }
    const remainingWaitMs = waitDeadlineMs - performance.now();
    if (remainingWaitMs <= 0) {
      // Fail open: deliver instead of parking indefinitely. Newer winners that
      // complete before the budget expires still cancel this payload on the
      // recheck above; past expiry a race with an in-flight newer delivery is
      // the accepted cost of bounded waiting.
      return false;
    }
    // Wait for newer generations to settle before deciding whether this delivery is stale.
    await waitForForegroundReplyFenceChange(state, remainingWaitMs);
  }
}

function waitForForegroundReplyFenceChange(
  state: ForegroundReplyFenceState,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const waiter = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      state.waiters.delete(waiter);
      resolve();
    }, timeoutMs);
    timer.unref?.();
    state.waiters.add(waiter);
  });
}

export function markForegroundReplyFenceVisibleDelivery(
  snapshot: ForegroundReplyFenceSnapshot | undefined,
  payload: ReplyPayload,
  deliveryResult: unknown,
): void {
  if (!snapshot || !hasOutboundReplyContent(payload, { trimText: true })) {
    return;
  }
  if (isExplicitlyNonVisibleDelivery(deliveryResult)) {
    return;
  }
  // A visible payload with no explicit negative delivery result becomes the generation winner.
  markForegroundReplyFenceVisibleDeliveryGeneration(snapshot);
}

export function markForegroundReplyFenceVisibleDeliveryGeneration(
  snapshot: ForegroundReplyFenceSnapshot | undefined,
): void {
  if (!snapshot) {
    return;
  }
  const state = foregroundReplyFenceByKey.get(snapshot.key);
  if (!state) {
    return;
  }
  state.visibleDeliveryGeneration = Math.max(state.visibleDeliveryGeneration, snapshot.generation);
  notifyForegroundReplyFenceWaiters(state);
}

function isExplicitlyNonVisibleDelivery(deliveryResult: unknown): boolean {
  return (
    typeof deliveryResult === "object" &&
    deliveryResult !== null &&
    !Array.isArray(deliveryResult) &&
    "visibleReplySent" in deliveryResult &&
    (deliveryResult as { visibleReplySent?: unknown }).visibleReplySent === false
  );
}

export function isExplicitlyVisibleDelivery(deliveryResult: unknown): boolean {
  return (
    typeof deliveryResult === "object" &&
    deliveryResult !== null &&
    !Array.isArray(deliveryResult) &&
    (deliveryResult as { visibleReplySent?: unknown }).visibleReplySent === true
  );
}

export function isVisiblePartialDeliveryError(error: unknown): boolean {
  if (isOutboundDeliveryError(error)) {
    return error.sentBeforeError;
  }
  return (
    typeof error === "object" &&
    error !== null &&
    !Array.isArray(error) &&
    ((error as { visibleReplySent?: unknown }).visibleReplySent === true ||
      (error as { sentBeforeError?: unknown }).sentBeforeError === true)
  );
}

export async function runForegroundReplyFenceFreshSettledDelivery(
  snapshot: ForegroundReplyFenceSnapshot | undefined,
  onFreshSettledDelivery: (() => unknown) | undefined,
): Promise<void> {
  if (!onFreshSettledDelivery) {
    return;
  }
  const fenceWaitDeadlineMs = performance.now() + FOREGROUND_REPLY_FENCE_WAIT_TIMEOUT_MS;
  if (await shouldCancelForegroundReplyDelivery(snapshot, fenceWaitDeadlineMs)) {
    return;
  }
  try {
    const deliveryResult = await onFreshSettledDelivery();
    if (isExplicitlyVisibleDelivery(deliveryResult)) {
      markForegroundReplyFenceVisibleDeliveryGeneration(snapshot);
    }
  } catch (err: unknown) {
    if (isVisiblePartialDeliveryError(err)) {
      markForegroundReplyFenceVisibleDeliveryGeneration(snapshot);
    }
    throw err;
  }
}

export function endForegroundReplyFence(snapshot: ForegroundReplyFenceSnapshot): void {
  const state = foregroundReplyFenceByKey.get(snapshot.key);
  if (!state) {
    return;
  }
  const activeGenerationCount = state.activeGenerations.get(snapshot.generation) ?? 0;
  if (activeGenerationCount <= 1) {
    state.activeGenerations.delete(snapshot.generation);
  } else {
    state.activeGenerations.set(snapshot.generation, activeGenerationCount - 1);
  }
  state.suspendedGenerations.delete(snapshot.generation);
  state.activeDispatches -= 1;
  notifyForegroundReplyFenceWaiters(state);
  if (state.activeDispatches <= 0) {
    foregroundReplyFenceByKey.delete(snapshot.key);
  }
}
