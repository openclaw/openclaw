import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { ReplyToMode } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OutboundSendDeps } from "../../infra/outbound/send-deps.js";
import type { OutboundMediaAccess } from "../../media/load-options.js";
import type { PollInput } from "../../polls.js";

/** Delivery durability requested by core when a channel sends agent output. */
export type MessageDurabilityPolicy = "required" | "best_effort" | "disabled";

/** Capability names a channel must advertise before core can rely on durable final delivery. */
export const durableFinalDeliveryCapabilities = [
  "text",
  "media",
  "poll",
  "payload",
  "silent",
  "replyTo",
  "thread",
  "nativeQuote",
  "messageSendingHooks",
  "batch",
  "reconcileUnknownSend",
  "afterSendSuccess",
  "afterCommit",
] as const;

/** Durable final delivery capability key understood by message-channel adapters. */
export type DurableFinalDeliveryCapability = (typeof durableFinalDeliveryCapabilities)[number];

/** Capability map used by adapters to declare which final-send guarantees they support. */
export type DurableFinalDeliveryRequirementMap = Partial<
  Record<DurableFinalDeliveryCapability, boolean>
>;

/** Minimal payload facts used to derive required durable-delivery capabilities. */
export type DurableFinalDeliveryPayloadShape = {
  text?: string | null;
  replyToId?: string | null;
  mediaUrl?: string | null;
  mediaUrls?: readonly (string | null | undefined)[] | null;
};

/** Raw platform result shape normalized into a message receipt. */
export type MessageReceiptSourceResult = {
  /** Provider/channel id that produced the platform result. */
  channel?: string;
  /** Generic platform message id returned by most send APIs. */
  messageId?: string;
  /** Chat-scoped id used by some channel APIs as the sent message id. */
  chatId?: string;
  /** Channel-scoped id returned by workspace-style APIs. */
  channelId?: string;
  /** Room-scoped id returned by room-based providers. */
  roomId?: string;
  /** Conversation-scoped id returned by conversation-first providers. */
  conversationId?: string;
  /** WhatsApp/JID-style destination id used as a fallback receipt key. */
  toJid?: string;
  /** Poll id returned when the send created a platform poll. */
  pollId?: string;
  /** Platform send timestamp when the adapter exposes it. */
  timestamp?: number;
  /** Provider-native metadata retained for reconciliation/debugging. */
  meta?: Record<string, unknown>;
};

/** Logical part kind for multi-part rendered messages. */
export type MessageReceiptPartKind =
  | "text"
  | "media"
  | "voice"
  | "poll"
  | "card"
  | "preview"
  | "unknown";

/** One platform message produced by a logical outbound send. */
export type MessageReceiptPart = {
  /** Platform message id for this concrete sent part. */
  platformMessageId: string;
  /** Logical content kind that produced this part. */
  kind: MessageReceiptPartKind;
  /** Stable order within the logical send. */
  index: number;
  /** Thread/topic id used by the platform for this part. */
  threadId?: string;
  /** Platform message id this part replied to. */
  replyToId?: string;
  /** Raw adapter result retained when built from legacy send output. */
  raw?: MessageReceiptSourceResult;
};

/** Normalized receipt for all platform messages that make up a logical send. */
export type MessageReceipt = {
  /** Preferred platform id for edits/deletes when a logical send has multiple parts. */
  primaryPlatformMessageId?: string;
  /** Unique platform ids in send order. */
  platformMessageIds: string[];
  /** Per-part receipts for multipart sends. */
  parts: MessageReceiptPart[];
  /** Thread/topic id shared by the logical send when available. */
  threadId?: string;
  /** Reply target shared by the logical send when available. */
  replyToId?: string;
  /** Provider token required to edit the sent message. */
  editToken?: string;
  /** Provider token required to delete the sent message. */
  deleteToken?: string;
  /** Millisecond timestamp when core considers the logical send complete. */
  sentAt: number;
  /** Raw adapter results used to construct this normalized receipt. */
  raw?: readonly MessageReceiptSourceResult[];
};

/** Render-plan item category used before adapter-specific send execution. */
export type RenderedMessageBatchPlanKind =
  | "text"
  | "media"
  | "voice"
  | "presentation"
  | "interactive"
  | "channelData"
  | "empty";

/** Render plan for a single reply payload after text/media/presentation splitting. */
export type RenderedMessageBatchPlanItem = {
  index: number;
  kinds: readonly RenderedMessageBatchPlanKind[];
  text?: string;
  mediaUrls: readonly string[];
  audioAsVoice?: boolean;
  presentationBlockCount?: number;
  hasInteractive?: boolean;
  hasChannelData?: boolean;
};

/** Aggregate render plan for a batch of reply payloads. */
export type RenderedMessageBatchPlan = {
  payloadCount: number;
  textCount: number;
  mediaCount: number;
  voiceCount: number;
  presentationCount: number;
  interactiveCount: number;
  channelDataCount: number;
  items: readonly RenderedMessageBatchPlanItem[];
};

/** Rendered payload batch paired with the plan core uses for send routing and recovery. */
export type RenderedMessageBatch<TPayload = unknown> = {
  payloads: TPayload[];
  plan: RenderedMessageBatchPlan;
};

/** Lifecycle phase for a live preview or streaming message send. */
export type LiveMessagePhase = "idle" | "previewing" | "finalizing" | "finalized" | "cancelled";

/** Mutable state snapshot for live preview/finalization flows. */
export type LiveMessageState<TPayload = unknown> = {
  phase: LiveMessagePhase;
  canFinalizeInPlace: boolean;
  receipt?: MessageReceipt;
  lastRendered?: RenderedMessageBatch<TPayload>;
};

/** Durable send context passed through render, preview, send, edit, commit, and failure steps. */
export type MessageSendContext<TPayload = unknown, TSendResult = unknown> = {
  id: string;
  channel: string;
  to: string;
  accountId?: string;
  durability: Exclude<MessageDurabilityPolicy, "disabled">;
  attempt: number;
  signal: AbortSignal;
  intent?: DurableMessageSendIntent;
  previousReceipt?: MessageReceipt;
  preview?: LiveMessageState<TPayload>;
  render(): Promise<RenderedMessageBatch<TPayload>>;
  previewUpdate(rendered: RenderedMessageBatch<TPayload>): Promise<LiveMessageState<TPayload>>;
  send(rendered: RenderedMessageBatch<TPayload>): Promise<TSendResult>;
  edit(receipt: MessageReceipt, rendered: RenderedMessageBatch<TPayload>): Promise<MessageReceipt>;
  delete(receipt: MessageReceipt): Promise<void>;
  commit(receipt: MessageReceipt): Promise<void>;
  fail(error: unknown): Promise<void>;
};

/** Common text-send context shared by text, media, payload, and poll adapter calls. */
export type ChannelMessageSendTextContext<TConfig = OpenClawConfig> = {
  cfg: TConfig;
  to: string;
  text: string;
  accountId?: string | null;
  deps?: OutboundSendDeps;
  replyToId?: string | null;
  replyToIdSource?: "explicit" | "implicit";
  replyToMode?: ReplyToMode;
  threadId?: string | number | null;
  silent?: boolean;
  signal?: AbortSignal;
  gatewayClientScopes?: readonly string[];
};

/** Media send context with validated access hooks and media presentation hints. */
export type ChannelMessageSendMediaContext<TConfig = OpenClawConfig> =
  ChannelMessageSendTextContext<TConfig> & {
    mediaUrl: string;
    mediaAccess?: OutboundMediaAccess;
    mediaLocalRoots?: readonly string[];
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
    audioAsVoice?: boolean;
    gifPlayback?: boolean;
    forceDocument?: boolean;
  };

/** Rich reply payload send context used when adapters can consume structured payloads. */
export type ChannelMessageSendPayloadContext<TConfig = OpenClawConfig> =
  ChannelMessageSendTextContext<TConfig> & {
    payload: ReplyPayload;
    mediaUrl?: string;
    mediaAccess?: OutboundMediaAccess;
    mediaLocalRoots?: readonly string[];
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
    audioAsVoice?: boolean;
    gifPlayback?: boolean;
    forceDocument?: boolean;
  };

/** Poll send context; thread ids stay string-like because poll APIs do not accept numeric ids. */
export type ChannelMessageSendPollContext<TConfig = OpenClawConfig> = Omit<
  ChannelMessageSendTextContext<TConfig>,
  "text" | "threadId"
> & {
  poll: PollInput;
  threadId?: string | null;
  isAnonymous?: boolean;
};

/** Adapter send result normalized to a receipt plus optional legacy message id. */
export type ChannelMessageSendResult = {
  receipt: MessageReceipt;
  messageId?: string;
};

/** Discriminator for lifecycle hooks around a concrete adapter send attempt. */
export type ChannelMessageSendAttemptKind = "text" | "media" | "payload" | "poll";

/** Send-attempt context tagged with the adapter method core is about to call. */
export type ChannelMessageSendAttemptContext<TConfig = OpenClawConfig> =
  | (ChannelMessageSendTextContext<TConfig> & { kind: "text" })
  | (ChannelMessageSendMediaContext<TConfig> & { kind: "media" })
  | (ChannelMessageSendPayloadContext<TConfig> & { kind: "payload" })
  | (ChannelMessageSendPollContext<TConfig> & { kind: "poll" });

/** Lifecycle context emitted after an adapter send succeeds but before commit finishes. */
export type ChannelMessageSendSuccessContext<
  TConfig = OpenClawConfig,
  TSendResult extends ChannelMessageSendResult = ChannelMessageSendResult,
> = ChannelMessageSendAttemptContext<TConfig> & {
  result: TSendResult;
  attemptToken?: unknown;
};

/** Lifecycle context emitted after an adapter send throws or rejects. */
export type ChannelMessageSendFailureContext<TConfig = OpenClawConfig> =
  ChannelMessageSendAttemptContext<TConfig> & {
    error: unknown;
    attemptToken?: unknown;
  };

/** Lifecycle context emitted when a successful send is being durably committed. */
export type ChannelMessageSendCommitContext<
  TConfig = OpenClawConfig,
  TSendResult extends ChannelMessageSendResult = ChannelMessageSendResult,
> = ChannelMessageSendSuccessContext<TConfig, TSendResult>;

/** Durable queue context used to reconcile a send whose platform state is unknown. */
export type ChannelMessageUnknownSendContext<TConfig = OpenClawConfig> = {
  cfg: TConfig;
  queueId: string;
  channel: string;
  to: string;
  accountId?: string | null;
  enqueuedAt: number;
  retryCount: number;
  platformSendStartedAt?: number;
  payloads: readonly ReplyPayload[];
  renderedBatchPlan?: RenderedMessageBatchPlan;
  replyToId?: string | null;
  replyToMode?: ReplyToMode;
  threadId?: string | number | null;
  silent?: boolean;
};

/** Adapter verdict for whether an unknown queued send reached the platform. */
export type ChannelMessageUnknownSendReconciliationResult =
  | {
      status: "sent";
      receipt: MessageReceipt;
      messageId?: string;
    }
  | {
      status: "not_sent";
    }
  | {
      status: "unresolved";
      error?: string;
      retryable?: boolean;
    };

/** Optional hooks around adapter send attempts, platform success/failure, and commit. */
export type ChannelMessageSendLifecycleAdapter<
  TConfig = OpenClawConfig,
  TSendResult extends ChannelMessageSendResult = ChannelMessageSendResult,
> = {
  beforeSendAttempt?: (ctx: ChannelMessageSendAttemptContext<TConfig>) => unknown;
  afterSendSuccess?: (
    ctx: ChannelMessageSendSuccessContext<TConfig, TSendResult>,
  ) => Promise<void> | void;
  afterSendFailure?: (ctx: ChannelMessageSendFailureContext<TConfig>) => Promise<void> | void;
  afterCommit?: (
    ctx: ChannelMessageSendCommitContext<TConfig, TSendResult>,
  ) => Promise<void> | void;
};

/** Adapter methods a message channel can implement for outbound text/media/payload/poll sends. */
export type ChannelMessageSendAdapter<
  TConfig = OpenClawConfig,
  TSendResult extends ChannelMessageSendResult = ChannelMessageSendResult,
> = {
  text?: (ctx: ChannelMessageSendTextContext<TConfig>) => Promise<TSendResult>;
  media?: (ctx: ChannelMessageSendMediaContext<TConfig>) => Promise<TSendResult>;
  payload?: (ctx: ChannelMessageSendPayloadContext<TConfig>) => Promise<TSendResult>;
  poll?: (ctx: ChannelMessageSendPollContext<TConfig>) => Promise<TSendResult>;
  lifecycle?: ChannelMessageSendLifecycleAdapter<TConfig, TSendResult>;
};

/** Durable final-delivery extension for queue reconciliation and capability declaration. */
export type ChannelMessageDurableFinalAdapter = {
  capabilities?: DurableFinalDeliveryRequirementMap;
  reconcileUnknownSend?: (
    ctx: ChannelMessageUnknownSendContext,
  ) =>
    | Promise<ChannelMessageUnknownSendReconciliationResult | null>
    | ChannelMessageUnknownSendReconciliationResult
    | null;
};

/** Live-message feature key declared by adapters that support preview or streaming behavior. */
export type ChannelMessageLiveCapability =
  | "draftPreview"
  | "previewFinalization"
  | "progressUpdates"
  | "nativeStreaming"
  | "quietFinalization";

/** Canonical ordered list of live-message feature keys. */
export const channelMessageLiveCapabilities = [
  "draftPreview",
  "previewFinalization",
  "progressUpdates",
  "nativeStreaming",
  "quietFinalization",
] as const satisfies readonly ChannelMessageLiveCapability[];

/** Capability keys for turning a preview into a final platform message. */
export const livePreviewFinalizerCapabilities = [
  "finalEdit",
  "normalFallback",
  "discardPending",
  "previewReceipt",
  "retainOnAmbiguousFailure",
] as const;

/** Finalizer capability key understood by live-message adapters. */
export type LivePreviewFinalizerCapability = (typeof livePreviewFinalizerCapabilities)[number];

/** Capability map for preview finalization behavior. */
export type LivePreviewFinalizerCapabilityMap = Partial<
  Record<LivePreviewFinalizerCapability, boolean>
>;

/** Adapter shape for finalizing live previews. */
export type ChannelMessageLiveFinalizerAdapterShape = {
  capabilities?: LivePreviewFinalizerCapabilityMap;
};

/** Adapter shape for live preview and streaming message features. */
export type ChannelMessageLiveAdapterShape = {
  capabilities?: Partial<Record<ChannelMessageLiveCapability, boolean>>;
  finalizer?: ChannelMessageLiveFinalizerAdapterShape;
};

/** Receive acknowledgement timing policy for durable inbound message records. */
export type ChannelMessageReceiveAckPolicy =
  | "after_receive_record"
  | "after_agent_dispatch"
  | "after_durable_send"
  | "manual";

/** Canonical ordered list of receive acknowledgement policies. */
export const channelMessageReceiveAckPolicies = [
  "after_receive_record",
  "after_agent_dispatch",
  "after_durable_send",
  "manual",
] as const satisfies readonly ChannelMessageReceiveAckPolicy[];

/** Adapter receive shape for default and supported inbound acknowledgement policies. */
export type ChannelMessageReceiveAdapterShape = {
  defaultAckPolicy?: ChannelMessageReceiveAckPolicy;
  supportedAckPolicies?: readonly ChannelMessageReceiveAckPolicy[];
};

/** Full message adapter shape composed from send, durable-final, live, and receive facets. */
export type ChannelMessageAdapterShape<
  TConfig = OpenClawConfig,
  TSendResult extends ChannelMessageSendResult = ChannelMessageSendResult,
> = {
  id?: string;
  durableFinal?: ChannelMessageDurableFinalAdapter;
  send?: ChannelMessageSendAdapter<TConfig, TSendResult>;
  live?: ChannelMessageLiveAdapterShape;
  receive?: ChannelMessageReceiveAdapterShape;
};

/** Concrete message adapter type, preserving channel-specific adapter refinements. */
export type ChannelMessageAdapter<
  TAdapter extends ChannelMessageAdapterShape = ChannelMessageAdapterShape,
> = TAdapter;

/** Extra durable-final requirement map for caller-derived capability checks. */
export type DurableFinalRequirementExtras = DurableFinalDeliveryRequirementMap;

/** Inputs used to derive durable final-delivery requirements for a planned send. */
export type DeriveDurableFinalDeliveryRequirementsParams = {
  payload: DurableFinalDeliveryPayloadShape;
  /** Reply target means the adapter needs reply-to durability support. */
  replyToId?: string | null;
  /** Thread target means the adapter needs thread durability support. */
  threadId?: string | number | null;
  /** Silent sends require adapters to declare silent final-delivery support. */
  silent?: boolean;
  /** Whether lifecycle hooks around sends must be preserved by durable delivery. */
  messageSendingHooks?: boolean;
  /** Whether the planned send uses the structured payload adapter path. */
  payloadTransport?: boolean;
  /** Whether multiple rendered payloads must be delivered as one durable logical batch. */
  batch?: boolean;
  /** Whether unknown platform-send outcomes require adapter reconciliation. */
  reconcileUnknownSend?: boolean;
  /** Whether post-send success hooks must run before the send is considered durable. */
  afterSendSuccess?: boolean;
  /** Whether commit hooks must run before the final receipt is trusted. */
  afterCommit?: boolean;
  /** Caller-supplied capabilities that extend the built-in derivation rules. */
  extraCapabilities?: DurableFinalRequirementExtras;
};

/** Stable intent record for a durable outbound message send. */
export type DurableMessageSendIntent<TPayload = unknown> = {
  /** Queue-stable id for this logical outbound send. */
  id: string;
  /** Channel id that owns the outbound send. */
  channel: string;
  /** Provider-native destination target. */
  to: string;
  /** Optional account scope used by multi-account channels. */
  accountId?: string;
  /** Durable policy selected after disabled sends have been filtered out. */
  durability: Exclude<MessageDurabilityPolicy, "disabled">;
  /** Last rendered payload batch, retained for retry/reconciliation. */
  renderedBatch?: RenderedMessageBatch<TPayload>;
};
