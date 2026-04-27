import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { ReplyToMode } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OutboundDeliveryResult } from "../../infra/outbound/deliver-types.js";
import type { OutboundDeliveryFormattingOptions } from "../../infra/outbound/formatting.js";
import type { OutboundIdentity } from "../../infra/outbound/identity-types.js";
import type { OutboundSendDeps } from "../../infra/outbound/send-deps.js";
import type { MessagePresentation, ReplyPayloadDeliveryPin } from "../../interactive/payload.js";
import type { OutboundMediaAccess } from "../../media/load-options.js";
import type {
  ChannelOutboundTargetMode,
  ChannelPollContext,
  ChannelPollResult,
} from "./types.core.js";

export type ChannelOutboundContext = {
  cfg: OpenClawConfig;
  to: string;
  text: string;
  mediaUrl?: string;
  audioAsVoice?: boolean;
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  gifPlayback?: boolean;
  /** Send image as document to avoid Telegram compression. */
  forceDocument?: boolean;
  replyToId?: string | null;
  replyToIdSource?: "explicit" | "implicit";
  replyToMode?: ReplyToMode;
  formatting?: OutboundDeliveryFormattingOptions;
  threadId?: string | number | null;
  accountId?: string | null;
  /**
   * Stable routing/attribution identifier for the originating agent. Distinct
   * from display `identity` (name/avatar/emoji/theme), which is presentation-
   * layer metadata. Channel plugins that model each agent as a separate remote
   * identity (one row/handle per agent rather than a shared bot with per-
   * message costumes) need this id to attribute outbound sends without
   * smuggling the value through display fields. Available on inbound-driven
   * replies via the originating route AND on heartbeat/cron/sessions_send/
   * autonomous paths via the upstream session/mirror context. (#70905)
   */
  agentId?: string;
  identity?: OutboundIdentity;
  deps?: OutboundSendDeps;
  silent?: boolean;
  gatewayClientScopes?: readonly string[];
};

export type ChannelOutboundPayloadContext = ChannelOutboundContext & {
  payload: ReplyPayload;
};

export type ChannelPresentationCapabilities = {
  supported?: boolean;
  buttons?: boolean;
  selects?: boolean;
  context?: boolean;
  divider?: boolean;
};

export type ChannelDeliveryCapabilities = {
  pin?: boolean;
};

export type ChannelOutboundPayloadHint =
  | { kind: "approval-pending"; approvalKind: "exec" | "plugin" }
  | { kind: "approval-resolved"; approvalKind: "exec" | "plugin" };

export type ChannelOutboundTargetRef = {
  channel: string;
  to: string;
  accountId?: string | null;
  threadId?: string | number | null;
};

export type ChannelOutboundFormattedContext = ChannelOutboundContext & {
  abortSignal?: AbortSignal;
};

export type ChannelOutboundChunkContext = {
  formatting?: OutboundDeliveryFormattingOptions;
};

export type ChannelOutboundAdapter = {
  deliveryMode: "direct" | "gateway" | "hybrid";
  chunker?: ((text: string, limit: number, ctx?: ChannelOutboundChunkContext) => string[]) | null;
  chunkerMode?: "text" | "markdown";
  /** Lift remote Markdown image syntax in text into outbound media attachments. */
  extractMarkdownImages?: boolean;
  textChunkLimit?: number;
  sanitizeText?: (params: { text: string; payload: ReplyPayload }) => string;
  pollMaxOptions?: number;
  supportsPollDurationSeconds?: boolean;
  supportsAnonymousPolls?: boolean;
  normalizePayload?: (params: { payload: ReplyPayload }) => ReplyPayload | null;
  shouldSkipPlainTextSanitization?: (params: { payload: ReplyPayload }) => boolean;
  resolveEffectiveTextChunkLimit?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    fallbackLimit?: number;
  }) => number | undefined;
  shouldSuppressLocalPayloadPrompt?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    payload: ReplyPayload;
    hint?: ChannelOutboundPayloadHint;
  }) => boolean;
  beforeDeliverPayload?: (params: {
    cfg: OpenClawConfig;
    target: ChannelOutboundTargetRef;
    payload: ReplyPayload;
    hint?: ChannelOutboundPayloadHint;
  }) => Promise<void> | void;
  afterDeliverPayload?: (params: {
    cfg: OpenClawConfig;
    target: ChannelOutboundTargetRef;
    payload: ReplyPayload;
    results: readonly OutboundDeliveryResult[];
  }) => Promise<void> | void;
  presentationCapabilities?: ChannelPresentationCapabilities;
  deliveryCapabilities?: ChannelDeliveryCapabilities;
  renderPresentation?: (params: {
    payload: ReplyPayload;
    presentation: MessagePresentation;
    ctx: ChannelOutboundPayloadContext;
  }) => Promise<ReplyPayload | null> | ReplyPayload | null;
  pinDeliveredMessage?: (params: {
    cfg: OpenClawConfig;
    target: ChannelOutboundTargetRef;
    messageId: string;
    pin: ReplyPayloadDeliveryPin;
  }) => Promise<void> | void;
  /**
   * @deprecated Use shouldTreatDeliveredTextAsVisible instead.
   */
  shouldTreatRoutedTextAsVisible?: (params: {
    kind: "tool" | "block" | "final";
    text?: string;
  }) => boolean;
  shouldTreatDeliveredTextAsVisible?: (params: {
    kind: "tool" | "block" | "final";
    text?: string;
  }) => boolean;
  preferFinalAssistantVisibleText?: boolean;
  targetsMatchForReplySuppression?: (params: {
    originTarget: string;
    targetKey: string;
    targetThreadId?: string;
  }) => boolean;
  resolveTarget?: (params: {
    cfg?: OpenClawConfig;
    to?: string;
    allowFrom?: string[];
    accountId?: string | null;
    mode?: ChannelOutboundTargetMode;
  }) => { ok: true; to: string } | { ok: false; error: Error };
  sendPayload?: (ctx: ChannelOutboundPayloadContext) => Promise<OutboundDeliveryResult>;
  sendFormattedText?: (ctx: ChannelOutboundFormattedContext) => Promise<OutboundDeliveryResult[]>;
  sendFormattedMedia?: (
    ctx: ChannelOutboundFormattedContext & { mediaUrl: string },
  ) => Promise<OutboundDeliveryResult>;
  sendText?: (ctx: ChannelOutboundContext) => Promise<OutboundDeliveryResult>;
  sendMedia?: (ctx: ChannelOutboundContext) => Promise<OutboundDeliveryResult>;
  sendPoll?: (ctx: ChannelPollContext) => Promise<ChannelPollResult>;
};
