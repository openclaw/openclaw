// Shared reply dispatcher type contracts for visible and message-tool delivery.
import type { ReplyPayload } from "../types.js";

export type ReplyDispatchKind = "tool" | "block" | "final";

export type ReplyFollowupAdmissionBarrierTimeoutPolicy = {
  /** Absolute failsafe for owner activity that never settles. */
  maxTimeoutMs: number;
  /** Extend by another default settle interval while bounded owner work remains active. */
  shouldExtend: () => boolean;
};

export type ReplyDispatchRuntimeInfo = {
  /** Dispatcher-scoped identity shared by every callback for one queued payload. */
  deliveryId?: number;
  kind: ReplyDispatchKind;
  assistantMessageIndex?: number;
};

export type ReplyDispatchBeforeDeliver = (
  payload: ReplyPayload,
  info: ReplyDispatchRuntimeInfo,
) => Promise<ReplyPayload | null> | ReplyPayload | null;

export type ReplyDispatchAfterDeliverOutcome =
  | { status: "delivered"; result: unknown }
  | { status: "failed"; error: unknown };

export type ReplyDispatchAfterDeliver = (
  payload: ReplyPayload,
  info: ReplyDispatchRuntimeInfo,
  outcome: ReplyDispatchAfterDeliverOutcome,
) => Promise<void> | void;

/** An owner-declared settlement budget for one before-delivery callback. */
export type ReplyDispatchBeforeDeliverOptions = {
  /** Positive finite per-callback deadline in milliseconds; omit for the dispatcher default. */
  timeoutMs?: number;
};

export type ReplyDispatcher = {
  sendToolResult: (payload: ReplyPayload) => boolean;
  sendBlockReply: (payload: ReplyPayload) => boolean;
  sendFinalReply: (payload: ReplyPayload) => boolean;
  appendBeforeDeliver?: (
    hook: ReplyDispatchBeforeDeliver,
    options?: ReplyDispatchBeforeDeliverOptions,
  ) => void;
  /** Core lifecycle stages use prepend so they always run before provider preparation. */
  prependBeforeDeliver?: (
    hook: ReplyDispatchBeforeDeliver,
    options?: ReplyDispatchBeforeDeliverOptions,
  ) => void;
  /** Observe attempted native delivery without changing its result. */
  appendAfterDeliver?: (hook: ReplyDispatchAfterDeliver) => void;
  waitForIdle: () => Promise<void>;
  getQueuedCounts: () => Record<ReplyDispatchKind, number>;
  getCancelledCounts?: () => Record<ReplyDispatchKind, number>;
  getFailedCounts: () => Record<ReplyDispatchKind, number>;
  markComplete: () => void;
  /** Owner-declared deadline for holding queued follow-ups behind all queued deliveries. */
  resolveFollowupAdmissionBarrierTimeoutPolicy?: () =>
    | ReplyFollowupAdmissionBarrierTimeoutPolicy
    | undefined;
};

/**
 * Internal view for defensive outcome-count accounting. Some non-conforming
 * runtime dispatcher variants (for example plugin-provided dispatchers) may omit
 * these readers even though the public ReplyDispatcher contract requires
 * getFailedCounts. Read the counters through this view so the guards stay
 * type-correct without weakening the SDK-visible ReplyDispatcher type.
 */
export type DispatcherOutcomeCountsView = {
  getCancelledCounts?: () => Record<ReplyDispatchKind, number>;
  getFailedCounts?: () => Record<ReplyDispatchKind, number>;
};

export function readDispatcherFailedCounts(
  dispatcher: DispatcherOutcomeCountsView,
): Record<ReplyDispatchKind, number> {
  return dispatcher.getFailedCounts?.() ?? { tool: 0, block: 0, final: 0 };
}
