import type { CommandTurnKind } from "../../auto-reply/command-turn-context.js";
import type {
  GetReplyOptions,
  TurnAdoptionLifecycle,
} from "../../auto-reply/get-reply-options.types.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type {
  DispatchFromConfigResult,
  DispatchReplyFromConfig,
} from "../../auto-reply/reply/dispatch-from-config.types.js";
import type { GetReplyFromConfig } from "../../auto-reply/reply/get-reply.types.js";
import type { HistoryEntry, HistoryMediaEntry } from "../../auto-reply/reply/history.types.js";
import type { DispatchReplyWithBufferedBlockDispatcher } from "../../auto-reply/reply/provider-dispatcher.types.js";
import type { ReplyDispatcherWithTypingOptions } from "../../auto-reply/reply/reply-dispatcher.js";
import type { ReplyDispatchRuntimeInfo } from "../../auto-reply/reply/reply-dispatcher.types.js";
import type {
  FinalizedMsgContext,
  InboundSourceModality,
  MsgContext,
  SupplementalContextFacts,
} from "../../auto-reply/templating.js";
import type { GroupKeyResolution } from "../../config/sessions/types.js";
import type { DmScope } from "../../config/types.base.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  DeliverOutboundPayloadsParams,
  DurableFinalDeliveryRequirements,
} from "../../infra/outbound/deliver.js";
import type { OutboundPayloadPlan } from "../../infra/outbound/reply-payload-parts.js";
import type { MediaFact } from "../../media/media-facts.js";
import type { PluginCommandReplyOptions } from "../../plugins/plugin-command-dispatch-contract.js";
import type { ChatType } from "../chat-type.js";
import type { InboundEventKind } from "../inbound-event/kind.js";
import type { CreateChannelReplyPipelineParams } from "../message/reply-pipeline.js";
import type { InboundLastRouteUpdate, RecordInboundSession } from "../session.types.js";
import type { ChannelBotLoopProtectionFacts } from "./bot-loop-protection.js";
import type { ChannelDeliveryResult } from "./delivery-outcome.js";

export type { SupplementalContextFacts } from "../../auto-reply/templating.js";

export type ChannelTurnAdmission =
  | { kind: "dispatch"; reason?: string }
  | { kind: "observeOnly"; reason: string }
  | { kind: "handled"; reason: string }
  | { kind: "drop"; reason: string; recordHistory?: boolean };

export type ChannelEventClass = {
  kind: "message" | "command" | "interaction" | "reaction" | "lifecycle" | "unknown";
  canStartAgentTurn: boolean;
  requiresImmediateAck?: boolean;
};

export type NormalizedTurnInput = {
  id: string;
  timestamp?: number;
  rawText: string;
  textForAgent?: string;
  textForCommands?: string;
  raw?: unknown;
};

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

export type ConversationFacts = {
  kind: ChatType;
  id: string;
  label?: string;
  spaceId?: string;
  parentId?: string;
  threadId?: string;
  nativeChannelId?: string;
  avatar?: string;
  routePeer?: {
    kind: ChatType;
    id: string;
  };
};

export type RouteFacts = {
  agentId: string;
  dmScope?: DmScope;
  accountId?: string;
  routeSessionKey: string;
  dispatchSessionKey?: string;
  persistedSessionKey?: string;
  parentSessionKey?: string;
  modelParentSessionKey?: string;
  mainSessionKey?: string;
  createIfMissing?: boolean;
};

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
  sourceModality?: InboundSourceModality;
};

export type CommandFacts = {
  kind: CommandTurnKind;
  body?: string;
  name?: string;
  authorized?: boolean;
};

export type InboundMediaFacts = Omit<MediaFact, "staged" | "workspaceDir">;

type MaybePromise<T> = T | Promise<T>;

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

export type ChannelDeliveryInfo = ReplyDispatchRuntimeInfo;

type ChannelCoreManagedDeliveryInfo = Omit<
  ChannelDeliveryInfo,
  "assertPlatformSendAuthorized" | "bindPendingFinalDelivery" | "onPlatformSendDispatch"
>;

type ChannelProviderOwnedDeliveryInfo = ChannelDeliveryInfo & {
  assertPlatformSendAuthorized: () => void;
  onPlatformSendDispatch: () => Promise<void>;
};

export type { ChannelDeliveryOutcome, ChannelDeliveryResult } from "./delivery-outcome.js";

export type ChannelTurnDurableDeliveryOptions = Pick<
  DeliverOutboundPayloadsParams,
  | "deps"
  | "formatting"
  | "identity"
  | "mediaAccess"
  | "replyToMode"
  | "retryAmbiguousFinalText"
  | "silent"
  | "threadId"
> & {
  to?: string | null;
  replyToId?: string | null;
  requiredCapabilities?: DurableFinalDeliveryRequirements;
};

type ChannelDeliveryAdapterBase = {
  /** Return null when channel policy intentionally suppresses this logical payload. */
  preparePayload?: (
    payload: ReplyPayload,
    info: ChannelDeliveryInfo,
  ) => MaybePromise<ReplyPayload | null>;
  onDelivered?: (
    payload: ReplyPayload,
    info: ChannelDeliveryInfo,
    result: ChannelDeliveryResult | void,
  ) => Promise<void> | void;
  /** Let core emit the one canonical `message_sent` after non-durable provider settlement. */
  observeMessageSent?: true;
  onError?: (err: unknown, info: { kind: string }) => void;
};

export type ChannelCoreManagedTurnDeliveryAdapter = ChannelDeliveryAdapterBase & {
  deliver: (
    payload: ReplyPayload,
    info: ChannelCoreManagedDeliveryInfo,
  ) => Promise<ChannelDeliveryResult | void>;
  /** Receives an explicitly prepared plan without interpreting its text as directives. */
  deliverPrepared?: (
    plan: OutboundPayloadPlan,
    info: ChannelCoreManagedDeliveryInfo,
  ) => Promise<ChannelDeliveryResult | void>;
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
};

/** Delivery adapter used by legacy caller-assembled channel turns. */
export type ChannelEventDeliveryAdapter = ChannelCoreManagedTurnDeliveryAdapter;

export type ChannelProviderOwnedMessageSendingDeliveryAdapter = ChannelDeliveryAdapterBase & {
  /**
   * Provider funnel that owns `message_sending` after its native payload preparation.
   * Use only when delivery cannot declare its durable/direct branch before entering the
   * provider funnel; core still owns `reply_payload_sending` for this routed turn.
   */
  deliverWithProviderMessageSending: (
    payload: ReplyPayload,
    info: ChannelProviderOwnedDeliveryInfo,
  ) => Promise<ChannelDeliveryResult | void>;
  deliverPreparedWithProviderMessageSending?: (
    plan: OutboundPayloadPlan,
    info: ChannelProviderOwnedDeliveryInfo,
  ) => Promise<ChannelDeliveryResult | void>;
  deliver?: never;
  deliverPrepared?: never;
  durable?: never;
};

/** Delivery adapter used by modern routed channel turns. */
export type ChannelTurnDeliveryAdapter =
  | (ChannelCoreManagedTurnDeliveryAdapter & {
      deliverWithProviderMessageSending?: never;
      deliverPreparedWithProviderMessageSending?: never;
    })
  | ChannelProviderOwnedMessageSendingDeliveryAdapter;

export type ChannelTurnRecordOptions = {
  /**
   * Override the session used for metadata and transcript context.
   * Must be non-empty and contain no surrounding whitespace.
   */
  sessionKey?: string;
  groupResolution?: GroupKeyResolution | null;
  createIfMissing?: boolean;
  updateLastRoute?: InboundLastRouteUpdate;
  onRecordError?: (err: unknown) => void;
  trackSessionMetaTask?: (task: Promise<unknown>) => void;
};

export type ChannelTurnHistoryFinalizeOptions = {
  isGroup?: boolean;
  historyKey?: string;
  historyMap?: Map<string, HistoryEntry[]>;
  limit?: number;
};

export type ChannelTurnDroppedHistoryOptions = {
  key: string;
  limit: number;
  historyMap: Map<string, HistoryEntry[]>;
  recordOnDrop?: boolean;
  mediaLimit?: number;
  shouldRecord?: () => boolean;
};

type ChannelTurnDispatcherOptions = Omit<
  ReplyDispatcherWithTypingOptions,
  "deliver" | "deliverPrepared" | "onError"
>;

/** Reply options plus the opaque native command ownership decision carried by channel turns. */
type ChannelTurnReplyOptions = Omit<GetReplyOptions, "onBlockReply" | "onPreparedBlockReply"> &
  PluginCommandReplyOptions;

type ChannelTurnReplyPipelineOptions = Omit<
  CreateChannelReplyPipelineParams,
  "cfg" | "agentId" | "channel" | "accountId"
>;

type ChannelTurnContext = {
  channel: string;
  accountId?: string;
  routeSessionKey: string;
  storePath: string;
  ctxPayload: FinalizedMsgContext;
  recordInboundSession: RecordInboundSession;
  /** Current channel authority at record and dispatch initiation, after awaited preparation. */
  assertAuthority?: () => void;
  afterRecord?: () => void | Promise<void>;
  record?: ChannelTurnRecordOptions;
  history?: ChannelTurnHistoryFinalizeOptions;
  admission?: Extract<ChannelTurnAdmission, { kind: "dispatch" | "observeOnly" }>;
  botLoopProtection?: ChannelBotLoopProtectionFacts;
  /** Transport-defined outbound source identity, such as a webhook id. */
  outboundEchoSourceId?: string;
  log?: (event: ChannelTurnLogEvent) => void;
  messageId?: string;
};

export type AssembledChannelTurn = ChannelTurnContext & {
  cfg: OpenClawConfig;
  agentId: string;
  dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcher;
  delivery: ChannelEventDeliveryAdapter;
  replyPipeline?: ChannelTurnReplyPipelineOptions;
  dispatcherOptions?: ChannelTurnDispatcherOptions;
  toolsAllow?: string[];
  replyOptions?: ChannelTurnReplyOptions;
  replyResolver?: GetReplyFromConfig;
  /** Instance-bound reply dispatcher supplied by the owning plugin runtime. */
  dispatchReplyFromConfig?: DispatchReplyFromConfig;
  sessionInitRetry?: {
    delaysMs: readonly number[];
    signal?: AbortSignal;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  };
  /** Canonical adoption lifecycle threaded into replyOptions. */
  turnAdoptionLifecycle?: TurnAdoptionLifecycle;
};

type PreparedChannelTurnDispatchSkipReason = "botLoopProtection" | "observeOnly" | "outboundEcho";

type PreparedChannelTurnDispatchLifecycle = {
  /** Exact adoption lifecycle captured by runDispatch, or undefined for non-durable turns. */
  turnAdoptionLifecycle: TurnAdoptionLifecycle | undefined;
  /** Releases resources that runDispatch would otherwise settle when dispatch is skipped. */
  onDispatchSkipped: (reason: PreparedChannelTurnDispatchSkipReason) => void | Promise<void>;
};

export type PreparedChannelTurn<TDispatchResult = DispatchFromConfigResult> = ChannelTurnContext & {
  onPreDispatchFailure?: (err: unknown) => void | Promise<void>;
  runDispatch: () => Promise<TDispatchResult>;
  /** Optional for the legacy direct prepared runner; inbound adapters use the stricter type. */
  runDispatchLifecycle?: PreparedChannelTurnDispatchLifecycle;
  observeOnlyDispatchResult?: TDispatchResult;
};

type ChannelTurnRoute = {
  agentId: string;
  dmScope?: DmScope;
  sessionKey: string;
};

type RoutedChannelTurn<T> = Omit<T, "routeSessionKey" | "storePath" | "recordInboundSession"> & {
  route: ChannelTurnRoute;
};

type InboundPreparedChannelTurn<TDispatchResult = DispatchFromConfigResult> =
  PreparedChannelTurn<TDispatchResult> & {
    runDispatchLifecycle: PreparedChannelTurnDispatchLifecycle;
  };

export type ChannelTurnPlan<
  TDelivery extends ChannelTurnDeliveryAdapter = ChannelCoreManagedTurnDeliveryAdapter,
> = RoutedChannelTurn<
  Omit<
    AssembledChannelTurn,
    "agentId" | "delivery" | "dispatchReplyWithBufferedBlockDispatcher"
  > & {
    delivery: TDelivery;
  }
>;

type PreparedChannelTurnPlan<TDispatchResult = DispatchFromConfigResult> = RoutedChannelTurn<
  InboundPreparedChannelTurn<TDispatchResult>
> & {
  cfg: OpenClawConfig;
};

export type ChannelTurnResolved<
  TDispatchResult = DispatchFromConfigResult,
  TDelivery extends ChannelTurnDeliveryAdapter = ChannelCoreManagedTurnDeliveryAdapter,
> =
  | ChannelTurnPlan<TDelivery>
  | PreparedChannelTurnPlan<TDispatchResult>
  | AssembledChannelTurn
  | InboundPreparedChannelTurn<TDispatchResult>;

type ChannelTurnStage =
  | "ingest"
  | "classify"
  | "preflight"
  | "resolve"
  | "authorize"
  | "assemble"
  | "record"
  | "dispatch"
  | "finalize";

export type ChannelTurnLogEvent = {
  stage: ChannelTurnStage;
  event: "start" | "done" | "drop" | "handled" | "error" | "warning";
  channel: string;
  accountId?: string;
  messageId?: string;
  sessionKey?: string;
  admission?: ChannelTurnAdmission["kind"];
  reason?: string;
  error?: unknown;
};

export type ChannelTurnResult<TDispatchResult = DispatchFromConfigResult> =
  | DispatchedChannelTurnResult<TDispatchResult>
  | {
      admission: ChannelTurnAdmission;
      dispatched: false;
      ctxPayload?: MsgContext;
      routeSessionKey?: string;
    };

export type DispatchedChannelTurnResult<TDispatchResult = DispatchFromConfigResult> = {
  admission: Extract<ChannelTurnAdmission, { kind: "dispatch" | "observeOnly" }>;
  dispatched: true;
  ctxPayload: MsgContext;
  routeSessionKey: string;
  dispatchResult: TDispatchResult;
};

type ChannelTurnAdapter<
  TRaw,
  TDispatchResult = DispatchFromConfigResult,
  TDelivery extends ChannelTurnDeliveryAdapter = ChannelCoreManagedTurnDeliveryAdapter,
> = {
  ingest: (raw: TRaw) => MaybePromise<NormalizedTurnInput | null>;
  classify?: (input: NormalizedTurnInput) => MaybePromise<ChannelEventClass>;
  preflight?: (
    input: NormalizedTurnInput,
    eventClass: ChannelEventClass,
  ) => MaybePromise<PreflightFacts | ChannelTurnAdmission | null | undefined>;
  resolveTurn: (
    input: NormalizedTurnInput,
    eventClass: ChannelEventClass,
    preflight: PreflightFacts,
  ) => MaybePromise<ChannelTurnResolved<TDispatchResult, TDelivery>>;
  onFinalize?: (result: ChannelTurnResult<TDispatchResult>) => Promise<void> | void;
};

export type RunChannelTurnParams<
  TRaw,
  TDispatchResult = DispatchFromConfigResult,
  TDelivery extends ChannelTurnDeliveryAdapter = ChannelCoreManagedTurnDeliveryAdapter,
> = {
  channel: string;
  accountId?: string;
  raw: TRaw;
  adapter: ChannelTurnAdapter<TRaw, TDispatchResult, TDelivery>;
  log?: (event: ChannelTurnLogEvent) => void;
  /** Canonical adoption lifecycle for this turn. */
  turnAdoptionLifecycle?: TurnAdoptionLifecycle;
};
