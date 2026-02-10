/**
 * Discord WebSocket recovery state.
 * Tracks transient disconnects (1006) and provides outbound queuing.
 */

import type { RequestClient } from "@buape/carbon";
import type { ChunkMode } from "../auto-reply/chunk.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { MarkdownTableMode } from "../config/types.base.js";
import type { RuntimeEnv } from "../runtime.js";

const RECOVERY_WINDOW_MS = 30_000;

export type QueuedDeliveryParams = {
  target: string;
  replies: ReplyPayload[];
  replyToId?: string;
  token: string;
  accountId: string;
  rest?: RequestClient;
  runtime: RuntimeEnv;
  textLimit: number;
  maxLinesPerMessage?: number;
  tableMode?: MarkdownTableMode;
  chunkMode?: ChunkMode;
};

type AccountRecoveryState = {
  recovering: boolean;
  recoverUntil: number;
  queue: QueuedDeliveryParams[];
  flushHandler?: (queued: QueuedDeliveryParams[]) => Promise<void>;
};

const accountStates = new Map<string, AccountRecoveryState>();

function getOrCreateState(accountId: string): AccountRecoveryState {
  let state = accountStates.get(accountId);
  if (!state) {
    state = {
      recovering: false,
      recoverUntil: 0,
      queue: [],
    };
    accountStates.set(accountId, state);
  }
  return state;
}

/**
 * Mark account as recovering from transient disconnect (e.g. 1006).
 */
export function setRecovering(accountId: string): void {
  const state = getOrCreateState(accountId);
  state.recovering = true;
  state.recoverUntil = Date.now() + RECOVERY_WINDOW_MS;
}

/**
 * Clear recovery state, invoke flush handler if registered, and return queued count.
 */
export async function clearRecoveringAndFlush(accountId: string): Promise<number> {
  const state = accountStates.get(accountId);
  if (!state) {
    return 0;
  }
  state.recovering = false;
  state.recoverUntil = 0;
  const toFlush = [...state.queue];
  state.queue = [];
  if (toFlush.length > 0 && state.flushHandler) {
    await state.flushHandler(toFlush);
  }
  return toFlush.length;
}

/**
 * Clear recovery state and return queued deliveries (for explicit flush).
 */
export function clearRecovering(accountId: string): QueuedDeliveryParams[] {
  const state = accountStates.get(accountId);
  if (!state) {
    return [];
  }
  state.recovering = false;
  state.recoverUntil = 0;
  const toFlush = [...state.queue];
  state.queue = [];
  return toFlush;
}

/**
 * Register a handler to flush queued deliveries when recovery ends.
 */
export function setFlushHandler(
  accountId: string,
  handler: (queued: QueuedDeliveryParams[]) => Promise<void>,
): void {
  const state = getOrCreateState(accountId);
  state.flushHandler = handler;
}

/**
 * Check if account is in recovery (transient disconnect) window.
 */
export function isRecovering(accountId: string): boolean {
  const state = accountStates.get(accountId);
  if (!state || !state.recovering) {
    return false;
  }
  if (Date.now() >= state.recoverUntil) {
    state.recovering = false;
    state.queue = [];
    return false;
  }
  return true;
}

/**
 * Queue a delivery when in recovery state.
 */
export function queueDelivery(accountId: string, params: QueuedDeliveryParams): boolean {
  const state = accountStates.get(accountId);
  if (!state || !state.recovering) {
    return false;
  }
  state.queue.push(params);
  return true;
}

/**
 * Get queued delivery count for an account.
 */
export function getQueuedCount(accountId: string): number {
  return accountStates.get(accountId)?.queue.length ?? 0;
}

/**
 * Reset all recovery state. For tests only.
 */
export function resetRecoveryStateForTest(): void {
  accountStates.clear();
}
