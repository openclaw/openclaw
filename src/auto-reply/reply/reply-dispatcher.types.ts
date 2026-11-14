import type {
  ProgressContinuationCapability,
  ProgressContinuationReceipt,
} from "../../channels/progress-continuation.js";
import type { HumanDelayConfig } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OutboundPayloadPlan } from "../../infra/outbound/reply-payload-parts.js";
import type { SilentReplyConversationType } from "../../shared/silent-reply-policy.js";
import type { ReplyPayload } from "../types.js";
import type {
  NormalizeReplyOutcome,
  NormalizeReplySkipReason,
} from "./normalize-reply-skip-reason.js";
import type { ResponsePrefixContext } from "./response-prefix-template.js";

export type ReplyDispatchKind = "tool" | "block" | "final";

export type ReplyDispatchOperation =
  | { kind: "raw"; payload: ReplyPayload }
  | { kind: "prepared"; plan: OutboundPayloadPlan };

export type ReplyDispatchSettledCounts = {
  delivered: number;
  deliveredNotVisible: number;
  cancelled: number;
  failedBeforeSend: number;
  failedAfterSend: number;
};

export type ReplyDispatchReceipt = {
  counts: Record<ReplyDispatchKind, ReplyDispatchSettledCounts>;
  anyVisibleDelivered: boolean;
  /** Delivery is queued or ambiguous; another send could duplicate it. */
  hasPendingDelivery?: true;
};

export function mapReplyDispatchCounts<T, R>(
  counts: Record<ReplyDispatchKind, T>,
  select: (counts: T) => R,
): Record<ReplyDispatchKind, R> {
  return { tool: select(counts.tool), block: select(counts.block), final: select(counts.final) };
}

export type ReplyFollowupAdmissionBarrierTimeoutPolicy = {
  /** Absolute failsafe for owner activity that never settles. */
  maxTimeoutMs: number;
  /** Extend by another default settle interval while bounded owner work remains active. */
  shouldExtend: () => boolean;
};

export type ReplyDispatchRuntimeInfo = {
  kind: ReplyDispatchKind;
  assistantMessageIndex?: number;
  /** Display identity for replies in a configured multi-agent group. */
  participant?: { agentId: string; name: string };
  /** @internal Claim direct-send custody immediately before recipient-visible platform I/O. */
  onPlatformSendDispatch?: () => Promise<void>;
  /** @internal Synchronously fence custody after claiming it and before provider I/O. */
  assertPlatformSendAuthorized?: () => void;
  /** @internal Bind this delivery's host-owned completion to a transformed payload. */
  bindPendingFinalDelivery?: <T extends ReplyPayload>(payload: T) => T;
  /** @internal Hand this waiting reply's live progress draft to the children it waits on. */
  adoptProgressDraft?: ProgressContinuationCapability["adopt"];
  /**
   * @deprecated The 2026.9.8 receipt handoff. The host never offers it, so adapters
   * that check for it keep ordinary waiting-reply delivery. Use `adoptProgressDraft`;
   * removal requires an announced ordinary stable release window.
   */
  adoptProgressContinuation?: (
    this: void,
    receipt: ProgressContinuationReceipt,
  ) => Promise<boolean>;
};

export type ReplyDispatchBeforeDeliver = (
  payload: ReplyPayload,
  info: ReplyDispatchRuntimeInfo,
) => Promise<ReplyPayload | null> | ReplyPayload | null;

/** An owner-declared settlement budget for one before-delivery callback. */
export type ReplyDispatchBeforeDeliverOptions = {
  /** Positive finite per-callback deadline in milliseconds; omit for the dispatcher default. */
  timeoutMs?: number;
};

export type ReplyDispatcherOptions = {
  deliver: (payload: ReplyPayload, info: ReplyDispatchRuntimeInfo) => Promise<unknown>;
  /**
   * Receives a fresh plan after normalization and modifiers. When omitted, prepared
   * sends fall back to deliver(payload, info), retaining that adapter's raw contract.
   */
  deliverPrepared?: (plan: OutboundPayloadPlan, info: ReplyDispatchRuntimeInfo) => Promise<unknown>;
  /** The delivery callback admits custody before external I/O and owns failure settlement. */
  pendingFinalDeliveryAdmission?: "deliver";
  silentReplyContext?: {
    cfg?: OpenClawConfig;
    sessionKey?: string;
    surface?: string;
    conversationType?: SilentReplyConversationType;
  };
  responsePrefix?: string;
  transformReplyPayload?: (payload: ReplyPayload) => ReplyPayload | null;
  responsePrefixContext?: ResponsePrefixContext;
  /** Dynamic context provider for response prefix template interpolation.
   * Called at normalization time, after model selection is complete. */
  responsePrefixContextProvider?: () => ResponsePrefixContext;
  onHeartbeatStrip?: () => void;
  onIdle?: () => Promise<void> | void;
  onError?: (err: unknown, info: ReplyDispatchRuntimeInfo) => Promise<void> | void;
  /** Let ingress retry proven-unsent work only when outbound recovery holds no delivery. */
  propagateRetryableNoSendFailure?: boolean;
  /** Lets channels detect silent/empty drops for their empty-response fallback. */
  onSkip?: (
    payload: ReplyPayload,
    info: ReplyDispatchRuntimeInfo & { reason: NormalizeReplySkipReason },
  ) => void;
  humanDelay?: HumanDelayConfig;
  beforeDeliver?: ReplyDispatchBeforeDeliver;
  /** Owner-declared deadline for the constructor before-delivery callback. */
  beforeDeliverOptions?: ReplyDispatchBeforeDeliverOptions;
  onBeforeDeliverCancelled?: (
    payload: ReplyPayload,
    info: ReplyDispatchRuntimeInfo,
  ) => Promise<void> | void;
  /** Observe each queued payload settling, including cancellation and delivery failure. */
  onDeliverySettled?: (info: ReplyDispatchRuntimeInfo) => void;
  /** Resolve an owner activity policy for holding queued follow-ups behind delivery. */
  resolveFollowupAdmissionBarrierTimeoutPolicy?: (context: {
    queuedCounts: Readonly<Record<ReplyDispatchKind, number>>;
    humanDelayBudgetMs: number;
  }) => ReplyFollowupAdmissionBarrierTimeoutPolicy | undefined;
};

export type ReplyDispatcher = {
  /** @internal Preserve the delivery owner's preparation through dispatcher wrappers. */
  prepareReplyPayload?: (
    kind: ReplyDispatchKind,
    payload: ReplyPayload,
  ) => NormalizeReplyOutcome<ReplyPayload>;
  sendToolResult: (payload: ReplyPayload) => boolean;
  sendBlockReply: (payload: ReplyPayload) => boolean;
  sendFinalReply: (payload: ReplyPayload) => boolean;
  /** Preserve prepared text and fields through dispatch without raw directive parsing. */
  sendPreparedReply?: (kind: ReplyDispatchKind, plan: OutboundPayloadPlan) => boolean;
  appendBeforeDeliver?: (
    hook: ReplyDispatchBeforeDeliver,
    options?: ReplyDispatchBeforeDeliverOptions,
  ) => void;
  supportsSettledReceipt?: true;
  waitForIdle: () => Promise<void | ReplyDispatchReceipt>;
  /** @deprecated Use settled delivery receipts; this retains admission-time counts. */
  getQueuedCounts: () => Record<ReplyDispatchKind, number>;
  /** @deprecated Read cancellation counts from settled delivery receipts. */
  getCancelledCounts?: () => Record<ReplyDispatchKind, number>;
  /** @deprecated Read failure counts from settled delivery receipts. */
  getFailedCounts: () => Record<ReplyDispatchKind, number>;
  markComplete: () => void;
  /** Owner-declared deadline for holding queued follow-ups behind all queued deliveries. */
  resolveFollowupAdmissionBarrierTimeoutPolicy?: () =>
    | ReplyFollowupAdmissionBarrierTimeoutPolicy
    | undefined;
};
