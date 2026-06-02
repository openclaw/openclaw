import type { CommandTurnKind } from "../../auto-reply/command-turn-context.js";
import type { GetReplyOptions } from "../../auto-reply/get-reply-options.types.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { DispatchFromConfigResult } from "../../auto-reply/reply/dispatch-from-config.types.js";
import type { GetReplyFromConfig } from "../../auto-reply/reply/get-reply.types.js";
import type { HistoryEntry, HistoryMediaEntry } from "../../auto-reply/reply/history.types.js";
import type { DispatchReplyWithBufferedBlockDispatcher } from "../../auto-reply/reply/provider-dispatcher.types.js";
import type { ReplyDispatcherWithTypingOptions } from "../../auto-reply/reply/reply-dispatcher.js";
import type { ReplyDispatchKind } from "../../auto-reply/reply/reply-dispatcher.types.js";
import type { FinalizedMsgContext, MsgContext } from "../../auto-reply/templating.js";
import type { GroupKeyResolution } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  DeliverOutboundPayloadsParams,
  DurableFinalDeliveryRequirements,
  OutboundDeliveryQueuePolicy,
} from "../../infra/outbound/deliver.js";
import type { InboundEventKind } from "../inbound-event/kind.js";
import type { CreateChannelReplyPipelineParams } from "../message/reply-pipeline.js";
import type { MessageReceipt } from "../message/types.js";
import type { InboundLastRouteUpdate, RecordInboundSession } from "../session.types.js";
import type { ChannelBotLoopProtectionFacts } from "./bot-loop-protection.js";

export type { InboundEventKind } from "../inbound-event/kind.js";

/** Admission decision for an inbound channel event before agent dispatch. */
export type ChannelTurnAdmission =
  | { kind: "dispatch"; reason?: string }
  | { kind: "observeOnly"; reason: string }
  | { kind: "handled"; reason: string }
  | { kind: "drop"; reason: string; recordHistory?: boolean };

/** Coarse event classification used to decide whether an event can start an agent turn. */
export type ChannelEventClass = {
  kind: "message" | "command" | "interaction" | "reaction" | "lifecycle" | "unknown";
  canStartAgentTurn: boolean;
  requiresImmediateAck?: boolean;
};

/** Normalized inbound event text and raw payload after channel-specific ingestion. */
export type NormalizedTurnInput = {
  id: string;
  timestamp?: number;
  rawText: string;
  textForAgent?: string;
  textForCommands?: string;
  raw?: unknown;
};

/** Sender identity facts projected into channel access, routing, and prompt context. */
export type SenderFacts = {
  id?: string;
  name?: string;
  username?: string;
  tag?: string;
  roles?: string[];
  isBot?: boolean;
  isSelf?: boolean;
  displayLabel?: string;
};

/** Conversation identity and threading facts for a channel turn. */
export type ConversationFacts = {
  kind: "direct" | "group" | "channel";
  id: string;
  label?: string;
  spaceId?: string;
  parentId?: string;
  threadId?: string;
  nativeChannelId?: string;
  routePeer?: {
    kind: "direct" | "group" | "channel";
    id: string;
  };
};

/** Session routing facts derived before dispatch. */
export type RouteFacts = {
  agentId: string;
  accountId?: string;
  routeSessionKey: string;
  dispatchSessionKey?: string;
  persistedSessionKey?: string;
  parentSessionKey?: string;
  modelParentSessionKey?: string;
  mainSessionKey?: string;
  createIfMissing?: boolean;
};

/** Reply target and source-delivery facts for a channel turn. */
export type ReplyPlanFacts = {
  to: string;
  originatingTo?: string;
  nativeChannelId?: string;
  replyTarget?: string;
  deliveryTarget?: string;
  replyToId?: string;
  replyToIdFull?: string;
  messageThreadId?: string | number;
  threadParentId?: string;
  sourceReplyDeliveryMode?: "thread" | "reply" | "channel" | "direct" | "none";
};

/** Allowlist projection used by access checks without exposing raw configured entries. */
export type ProjectedAllowlistAccessFacts = {
  configured: boolean;
  matched: boolean;
  reasonCode?: string;
  matchedEntryIds: string[];
  invalidEntryCount: number;
  disabledEntryCount: number;
  accessGroups: {
    referenced: string[];
    matched: string[];
    missing: string[];
    unsupported: string[];
    failed: string[];
  };
};

/** Event-level access projection for commands, reactions, buttons, and native events. */
export type ProjectedEventAccessFacts = {
  kind:
    | "message"
    | "reaction"
    | "button"
    | "postback"
    | "native-command"
    | "slash-command"
    | "system";
  authMode: "inbound" | "command" | "origin-subject" | "route-only" | "none";
  mayPair: boolean;
  authorized: boolean;
  reasonCode?: string;
  hasOriginSubject: boolean;
  originSubjectMatched: boolean;
};

/** Access decisions for DMs, groups, commands, events, and mention gating. */
export type AccessFacts = {
  dm?: {
    decision: "allow" | "pairing" | "deny";
    reason?: string;
    /**
     * @deprecated Shared ingress projections redact allowlist entries and return an empty compat list.
     * Use allowlist diagnostics instead.
     */
    allowFrom: string[];
    allowlist?: ProjectedAllowlistAccessFacts;
  };
  group?: {
    policy: "open" | "allowlist" | "disabled";
    routeAllowed: boolean;
    senderAllowed: boolean;
    /**
     * @deprecated Shared ingress projections redact allowlist entries and return an empty compat list.
     * Use allowlist diagnostics instead.
     */
    allowFrom: string[];
    requireMention: boolean;
    allowlist?: ProjectedAllowlistAccessFacts;
  };
  commands?: {
    authorized?: boolean;
    shouldBlockControlCommand?: boolean;
    reasonCode?: string;
    useAccessGroups: boolean;
    allowTextCommands: boolean;
    modeWhenAccessGroupsOff?: "allow" | "deny" | "configured";
    /**
     * @deprecated Shared ingress projections do not expose raw authorizer lists.
     * Use authorized and reasonCode instead.
     */
    authorizers: Array<{ configured: boolean; allowed: boolean }>;
  };
  event?: ProjectedEventAccessFacts;
  mentions?: {
    canDetectMention: boolean;
    wasMentioned: boolean;
    hasAnyMention?: boolean;
    implicitMentionKinds?: Array<
      "reply_to_bot" | "quoted_bot" | "bot_thread_participant" | "native"
    >;
    requireMention?: boolean;
    effectiveWasMentioned?: boolean;
    shouldSkip?: boolean;
  };
};

/** Message text/history facts passed into templating and dispatch. */
export type MessageFacts = {
  inboundEventKind?: InboundEventKind;
  body?: string;
  rawBody: string;
  bodyForAgent?: string;
  commandBody?: string;
  envelopeFrom?: string;
  senderLabel?: string;
  preview?: string;
  inboundHistory?: HistoryEntry[];
};

/** Parsed command facts for command-like channel turns. */
export type CommandFacts = {
  kind: CommandTurnKind;
  body?: string;
  name?: string;
  authorized?: boolean;
};

/** Quoted, forwarded, thread, and untrusted context facts attached to an inbound turn. */
export type SupplementalContextFacts = {
  quote?: {
    id?: string;
    fullId?: string;
    body?: string;
    sender?: string;
    senderAllowed?: boolean;
    isExternal?: boolean;
    isQuote?: boolean;
  };
  forwarded?: {
    from?: string;
    fromType?: string;
    fromId?: string;
    date?: number;
    senderAllowed?: boolean;
  };
  thread?: {
    id?: string;
    starterBody?: string;
    historyBody?: string;
    label?: string;
    parentSessionKey?: string;
    modelParentSessionKey?: string;
    senderAllowed?: boolean;
  };
  untrustedContext?: Array<{ label: string; source?: string; type?: string; payload: unknown }>;
  groupSystemPrompt?: string;
  /** Prompt-like group metadata from user-controlled sources; never enters the system prompt. */
  untrustedGroupSystemPrompt?: string;
};

/** Inbound media facts supplied to the agent context. */
export type InboundMediaFacts = {
  path?: string;
  url?: string;
  contentType?: string;
  kind?: "image" | "video" | "audio" | "document" | "unknown";
  transcribed?: boolean;
  messageId?: string;
};

type MaybePromise<T> = T | Promise<T>;

/** Adapter preflight output assembled before turn resolution. */
export type PreflightFacts = {
  admission?: ChannelTurnAdmission;
  command?: CommandFacts;
  message?: Partial<MessageFacts>;
  media?:
    | readonly InboundMediaFacts[]
    | (() => MaybePromise<
        readonly InboundMediaFacts[] | readonly HistoryMediaEntry[] | null | undefined
      >);
  supplemental?: SupplementalContextFacts;
  history?: ChannelTurnDroppedHistoryOptions;
};

/** Delivery metadata for one reply payload dispatch. */
export type ChannelDeliveryInfo = {
  /** Reply dispatcher bucket that produced this payload. */
  kind: ReplyDispatchKind;
};

/** Durable delivery queue intent recorded when a reply is deferred. */
export type ChannelDeliveryIntent = {
  /** Durable outbound queue id for the logical reply send. */
  id: string;
  /** Discriminator for delivery intents created by the outbound queue. */
  kind: "outbound_queue";
  /** Queue durability policy selected for this delivery. */
  queuePolicy: OutboundDeliveryQueuePolicy;
};

/** Result returned after delivering one channel reply payload. */
export type ChannelDeliveryResult = {
  /** Platform message ids returned by legacy delivery adapters. */
  messageIds?: string[];
  /** Normalized message receipt returned by message-lifecycle delivery. */
  receipt?: MessageReceipt;
  /** Thread/topic id where the visible reply landed. */
  threadId?: string;
  /** Platform message id that the reply targeted. */
  replyToId?: string;
  /** Whether the delivery produced a visible platform reply. */
  visibleReplySent?: boolean;
  /** Durable outbound intent when delivery was queued or tracked asynchronously. */
  deliveryIntent?: ChannelDeliveryIntent;
};

/** Durable outbound delivery options available to channel turn delivery adapters. */
export type ChannelTurnDurableDeliveryOptions = Pick<
  DeliverOutboundPayloadsParams,
  "deps" | "formatting" | "identity" | "mediaAccess" | "replyToMode" | "silent" | "threadId"
> & {
  /** Explicit destination override; null prevents context fallback. */
  to?: string | null;
  /** Explicit reply target override; null prevents source-message fallback. */
  replyToId?: string | null;
  /** Capability requirements callers already derived for this payload. */
  requiredCapabilities?: DurableFinalDeliveryRequirements;
};

/** Delivery adapter used by channel turns to send reply payloads. */
export type ChannelEventDeliveryAdapter = {
  /** Normalizes or enriches reply payloads before durable/legacy delivery selection. */
  preparePayload?: (
    payload: ReplyPayload,
    info: ChannelDeliveryInfo,
  ) => Promise<ReplyPayload> | ReplyPayload;
  /** Legacy delivery path used when durable delivery is disabled or unsupported. */
  deliver: (
    payload: ReplyPayload,
    info: ChannelDeliveryInfo,
  ) => Promise<ChannelDeliveryResult | void>;
  /** Durable delivery options, or a per-payload resolver that can opt out with false. */
  durable?:
    | false
    | ChannelTurnDurableDeliveryOptions
    | ((
        payload: ReplyPayload,
        info: ChannelDeliveryInfo,
      ) =>
        | false
        | ChannelTurnDurableDeliveryOptions
        | Promise<false | ChannelTurnDurableDeliveryOptions>);
  /** Observer called after either durable or legacy delivery returns. */
  onDelivered?: (
    payload: ReplyPayload,
    info: ChannelDeliveryInfo,
    result: ChannelDeliveryResult | void,
  ) => Promise<void> | void;
  /** Error sink wired into the buffered reply dispatcher. */
  onError?: (err: unknown, info: { kind: string }) => void;
};

/** Options for recording inbound session route state around a turn. */
export type ChannelTurnRecordOptions = {
  /** Group-route resolution facts retained with the inbound session record. */
  groupResolution?: GroupKeyResolution | null;
  /** Whether the session recorder may create a missing session. */
  createIfMissing?: boolean;
  /** Last-route update to persist after this inbound turn. */
  updateLastRoute?: InboundLastRouteUpdate;
  /** Non-fatal record error sink used by compatibility dispatchers. */
  onRecordError?: (err: unknown) => void;
  /** Hook for async metadata work that should outlive the immediate record call. */
  trackSessionMetaTask?: (task: Promise<unknown>) => void;
};

/** Options for finalizing visible conversation history after dispatch. */
export type ChannelTurnHistoryFinalizeOptions = {
  /** Only group histories are cleared through this finalizer. */
  isGroup?: boolean;
  /** Caller-owned history map key for the conversation. */
  historyKey?: string;
  /** Caller-owned pending history storage. */
  historyMap?: Map<string, HistoryEntry[]>;
  /** Retention limit; undefined disables cleanup. */
  limit?: number;
};

/** Options for recording history when an inbound event is dropped before dispatch. */
export type ChannelTurnDroppedHistoryOptions = {
  /** Caller-owned history map key for the dropped conversation. */
  key: string;
  /** Retention limit for recorded dropped-message context. */
  limit: number;
  /** Caller-owned pending history storage. */
  historyMap: Map<string, HistoryEntry[]>;
  /** Record drops even when the admission did not explicitly request history. */
  recordOnDrop?: boolean;
  /** Retention limit for media attached to the dropped event. */
  mediaLimit?: number;
  /** Dynamic guard for channels that only record history under current config state. */
  shouldRecord?: () => boolean;
};

/** Dispatcher options excluding delivery hooks owned by the channel turn adapter. */
export type ChannelTurnDispatcherOptions = Omit<
  ReplyDispatcherWithTypingOptions,
  "deliver" | "onError"
>;

/** Reply pipeline options excluding cfg/agent/channel identity supplied by the turn. */
export type ChannelTurnReplyPipelineOptions = Omit<
  CreateChannelReplyPipelineParams,
  "cfg" | "agentId" | "channel" | "accountId"
>;

/** Fully assembled channel turn ready to build the dispatch runner. */
export type AssembledChannelTurn = {
  /** Config used for reply generation and outbound delivery. */
  cfg: OpenClawConfig;
  /** Channel id that owns the inbound turn. */
  channel: string;
  /** Optional account scope for multi-account channel adapters. */
  accountId?: string;
  /** Agent selected by routing before dispatch. */
  agentId: string;
  /** Stable route session key used when the context payload lacks a session key. */
  routeSessionKey: string;
  /** Session store path used by the recorder and reply dispatcher. */
  storePath: string;
  /** Finalized message context passed into templating and dispatch. */
  ctxPayload: FinalizedMsgContext;
  /** Session recorder that runs before reply dispatch. */
  recordInboundSession: RecordInboundSession;
  /** Buffered dispatcher that resolves tool/block/final reply payloads. */
  dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcher;
  /** Delivery adapter for final outbound reply payloads. */
  delivery: ChannelEventDeliveryAdapter;
  /** Optional reply pipeline knobs resolved just before dispatch. */
  replyPipeline?: ChannelTurnReplyPipelineOptions;
  /** Dispatcher options layered over reply pipeline callbacks. */
  dispatcherOptions?: ChannelTurnDispatcherOptions;
  /** Reply generation options forwarded without block-reply ownership. */
  replyOptions?: Omit<GetReplyOptions, "onBlockReply">;
  /** Optional reply resolver override for tests or specialized adapters. */
  replyResolver?: GetReplyFromConfig;
  /** Session recording options. */
  record?: ChannelTurnRecordOptions;
  /** History cleanup options after dispatch. */
  history?: ChannelTurnHistoryFinalizeOptions;
  /** Admission result when the adapter already decided dispatch vs observe-only. */
  admission?: Extract<ChannelTurnAdmission, { kind: "dispatch" | "observeOnly" }>;
  /** Bot-loop suppression facts evaluated before record/dispatch. */
  botLoopProtection?: ChannelBotLoopProtectionFacts;
  /** Structured lifecycle logger for turn execution. */
  log?: (event: ChannelTurnLogEvent) => void;
  /** Platform message id used in lifecycle logs. */
  messageId?: string;
};

/** Channel turn with dispatch runner already prepared. */
export type PreparedChannelTurn<TDispatchResult = DispatchFromConfigResult> = {
  /** Channel id that owns the inbound turn. */
  channel: string;
  /** Optional account scope for multi-account channel adapters. */
  accountId?: string;
  /** Stable route session key used when the context payload lacks a session key. */
  routeSessionKey: string;
  /** Session store path used by the recorder. */
  storePath: string;
  /** Finalized message context recorded before dispatch. */
  ctxPayload: FinalizedMsgContext;
  /** Session recorder that runs before the prepared dispatch callback. */
  recordInboundSession: RecordInboundSession;
  /** Session recording options. */
  record?: ChannelTurnRecordOptions;
  /** History cleanup options after dispatch. */
  history?: ChannelTurnHistoryFinalizeOptions;
  /** Callback invoked if session recording fails before dispatch starts. */
  onPreDispatchFailure?: (err: unknown) => void | Promise<void>;
  /** Prepared dispatch callback that emits the channel-specific reply result. */
  runDispatch: () => Promise<TDispatchResult>;
  /** Synthetic result returned when observe-only dispatch is suppressed. */
  observeOnlyDispatchResult?: TDispatchResult;
  /** Admission result when the adapter already decided dispatch vs observe-only. */
  admission?: Extract<ChannelTurnAdmission, { kind: "dispatch" | "observeOnly" }>;
  /** Bot-loop suppression facts evaluated before record/dispatch. */
  botLoopProtection?: ChannelBotLoopProtectionFacts;
  /** Structured lifecycle logger for turn execution. */
  log?: (event: ChannelTurnLogEvent) => void;
  /** Platform message id used in lifecycle logs. */
  messageId?: string;
};

/** Resolved turn shape returned by adapters before final run/dispatch handling. */
export type ChannelTurnResolved<TDispatchResult = DispatchFromConfigResult> =
  | (AssembledChannelTurn & {
      admission?: Extract<ChannelTurnAdmission, { kind: "dispatch" | "observeOnly" }>;
    })
  | (PreparedChannelTurn<TDispatchResult> & {
      admission?: Extract<ChannelTurnAdmission, { kind: "dispatch" | "observeOnly" }>;
    });

/** Ordered lifecycle stage names emitted to channel turn log hooks. */
export type ChannelTurnStage =
  | "ingest"
  | "classify"
  | "preflight"
  | "resolve"
  | "authorize"
  | "assemble"
  | "record"
  | "dispatch"
  | "finalize";

/** Structured channel turn log event. */
export type ChannelTurnLogEvent = {
  /** Turn lifecycle stage that emitted this event. */
  stage: ChannelTurnStage;
  /** Event kind within the lifecycle stage. */
  event: "start" | "done" | "drop" | "handled" | "error";
  /** Channel id that owns the event. */
  channel: string;
  /** Optional account scope for multi-account channel adapters. */
  accountId?: string;
  /** Platform message id associated with this turn. */
  messageId?: string;
  /** Session key associated with the current stage. */
  sessionKey?: string;
  /** Admission state active when the event was emitted. */
  admission?: ChannelTurnAdmission["kind"];
  /** Drop/handled reason when applicable. */
  reason?: string;
  /** Error captured for lifecycle error events. */
  error?: unknown;
};

/** Final result for a channel turn, dispatched or admitted without dispatch. */
export type ChannelTurnResult<TDispatchResult = DispatchFromConfigResult> =
  | DispatchedChannelTurnResult<TDispatchResult>
  | {
      admission: ChannelTurnAdmission;
      dispatched: false;
      ctxPayload?: MsgContext;
      routeSessionKey?: string;
    };

/** Successful dispatch result for a channel turn. */
export type DispatchedChannelTurnResult<TDispatchResult = DispatchFromConfigResult> = {
  admission: Extract<ChannelTurnAdmission, { kind: "dispatch" | "observeOnly" }>;
  dispatched: true;
  ctxPayload: MsgContext;
  routeSessionKey: string;
  dispatchResult: TDispatchResult;
};

/** Adapter contract for ingesting, classifying, resolving, and finalizing raw channel events. */
export type ChannelTurnAdapter<TRaw, TDispatchResult = DispatchFromConfigResult> = {
  /** Converts raw channel input into normalized turn input, or null to drop before logging. */
  ingest: (raw: TRaw) => Promise<NormalizedTurnInput | null> | NormalizedTurnInput | null;
  /** Classifies whether the normalized event can start an agent turn. */
  classify?: (input: NormalizedTurnInput) => Promise<ChannelEventClass> | ChannelEventClass;
  /** Performs access/mention/history/media preflight before route resolution. */
  preflight?: (
    input: NormalizedTurnInput,
    eventClass: ChannelEventClass,
  ) =>
    | Promise<PreflightFacts | ChannelTurnAdmission | null | undefined>
    | PreflightFacts
    | ChannelTurnAdmission
    | null
    | undefined;
  /** Resolves the normalized event into either an assembled or prepared turn. */
  resolveTurn: (
    input: NormalizedTurnInput,
    eventClass: ChannelEventClass,
    preflight: PreflightFacts,
  ) => Promise<ChannelTurnResolved<TDispatchResult>> | ChannelTurnResolved<TDispatchResult>;
  /** Final callback after dispatch or after a dispatch failure result has been assembled. */
  onFinalize?: (result: ChannelTurnResult<TDispatchResult>) => Promise<void> | void;
};

/** Parameters for running one raw channel event through the turn kernel. */
export type RunChannelTurnParams<TRaw, TDispatchResult = DispatchFromConfigResult> = {
  /** Channel id that owns the raw event. */
  channel: string;
  /** Optional account scope for multi-account channel adapters. */
  accountId?: string;
  /** Raw provider/channel event payload. */
  raw: TRaw;
  /** Adapter implementation for this raw event type. */
  adapter: ChannelTurnAdapter<TRaw, TDispatchResult>;
  /** Structured lifecycle logger for diagnostics and tests. */
  log?: (event: ChannelTurnLogEvent) => void;
};
