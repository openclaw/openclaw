import { asOptionalObjectRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AgentToolResult } from "../../agents/runtime/index.js";
import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import type { InboundEventKind } from "../../channels/inbound-event/kind.js";
import type { DurableMessageSendIntent, OutboundReplyFacts } from "../../channels/message/types.js";
import {
  normalizeConversationReadInvocationOrigin,
  type ConversationReadInvocationOrigin,
} from "../../channels/plugins/conversation-read-origin.js";
import type { AnyChannelPlugin as ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type {
  ChannelId,
  ChannelMessageActionContext,
  ChannelMessageActionName,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.public.js";
import type { ChannelProgressDraftCompositorSnapshot } from "../../channels/progress-draft-compositor.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MessageActionAuthorization } from "../../gateway/message-action-turn-capability.js";
import type { OutboundMediaAccess } from "../../media/load-options.js";
import type { GatewayClientMode, GatewayClientName } from "../../utils/message-channel.js";
import type { DeliverOutboundPayloadsParams } from "./deliver-contracts.js";
import type { ConversationDeliveryTarget } from "./delivery-completion.js";
import type { MessageBroadcastAccountPlan } from "./message-account-selection.js";
import type { MessageActionDeniedError } from "./message-action-denial.js";
import type {
  OutboundGatewayRequestContext,
  OutboundMessageGatewayOptionsInput,
} from "./message-gateway-options.js";
import type { MessagePollResult, MessageSendResult } from "./message.js";
import type { OutboundMirror } from "./mirror.js";
import type { ResolvedMessagingTarget } from "./target-resolver.js";

export type MessageActionGateway = Omit<
  OutboundMessageGatewayOptionsInput,
  "resolveAgentRuntimeIdentityToken"
> & {
  resolveAgentRuntimeIdentityToken?: (
    context?: OutboundGatewayRequestContext,
  ) => Promise<string | undefined>;
  terminalSourceReplyReceiptOwner?: "caller";
  clientName: GatewayClientName;
  clientDisplayName?: string;
  mode: GatewayClientMode;
};

export type MessageActionInput = Pick<
  DeliverOutboundPayloadsParams,
  | "cfg"
  | "runId"
  | "executionIdentityToken"
  | "mediaAccess"
  | "deps"
  | "preparedMessageId"
  | "deliveryIntentId"
  | "deliveryCompletion"
  | "onDeliveryAttempt"
  | "onDeliveryResult"
  | "onPlatformSendDispatch"
  | "assertDirectAdapterHandoff"
  | "skipQueue"
  | "abortSignal"
> & {
  action: ChannelMessageActionName;
  params: Record<string, unknown>;
  /** @internal Host-prepared display state for an existing progress message edit. */
  progressSnapshot?: ChannelProgressDraftCompositorSnapshot;
  /** @internal Identifies model-authored calls for lossy input normalization. */
  actionOrigin?: "message-tool";
  defaultAccountId?: string;
  requesterAccountId?: string | null;
  requesterSenderId?: string | null;
  requesterSenderName?: string | null;
  requesterSenderUsername?: string | null;
  requesterSenderE164?: string | null;
  senderIsOwner?: boolean;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  workspaceDir?: string;
  /** @internal Host-owned route plan computed before broadcast SecretRef resolution. */
  broadcastAccountPlan?: MessageBroadcastAccountPlan;
  /**
   * Authorization facts resolved from the host-issued current-turn capability.
   * Presence means ambient routing fields must not be used as identity.
   */
  messageActionAuthorization?: MessageActionAuthorization;
  sessionId?: string;
  toolContext?: ChannelThreadingToolContext;
  /** @internal Workspace transport reader whose use remains subject to sender policy. */
  workspaceMediaAccess?: OutboundMediaAccess;
  gateway?: MessageActionGateway;
  sessionKey?: string;
  /** @internal Durable session key for source-reply transcript and receipt state. */
  sourceReplySessionKey?: string;
  agentId?: string;
  /** Caller owns durable outbound context and must avoid the generic delivery mirror. */
  suppressTranscriptMirror?: boolean;
  /** @internal Explicit durable transcript destination owned by the caller. */
  transcriptMirror?: OutboundMirror;
  /** @internal The Gateway owns this call and may use its active gateway-mode adapter directly. */
  gatewayOwnedDelivery?: boolean;
  /** @internal Bypass provider-native action dispatch so core durable delivery owns the send. */
  forceCoreDelivery?: boolean;
  /** @internal Fail before platform I/O unless the core delivery queue persisted the intent. */
  requireQueuePersistence?: boolean;
  /** @internal Captured conversation storage facts, excluded from plugins and durable payloads. */
  conversationDeliveryTarget?: ConversationDeliveryTarget;
  /** @internal Runs after queue persistence and before platform I/O. */
  onDeliveryIntent?: (intent: DurableMessageSendIntent) => void;
  /** @internal Runs when broadcast converts a typed target denial into result text. */
  onActionDenied?: (
    error: MessageActionDeniedError,
    channel: ChannelId,
    receiptDiscriminator: string,
  ) => void;
  sandboxRoot?: string;
  sandboxContainerWorkdir?: string;
  dryRun?: boolean;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  /** The run answers another session, so an internal sink write reaches only its transcript. */
  sourceReplyTranscriptOnly?: boolean;
  sourceReplyFinal?: boolean;
  sourceReplyToolCallId?: string;
  inboundEventKind?: InboundEventKind;
  inboundAudio?: boolean;
};

export type MessageActionNormalization = {
  locationOmitted: true;
  notice: string;
};

export type MessageActionResult =
  | {
      kind: "send";
      channel: ChannelId;
      action: "send";
      to: string;
      handledBy: "plugin" | "core" | "internal-source";
      payload: unknown;
      normalization?: MessageActionNormalization;
      /** Exact text handed to the direct transport after core normalization and hooks. */
      deliveredText?: string;
      toolResult?: AgentToolResult<unknown>;
      sendResult?: MessageSendResult;
      dryRun: boolean;
    }
  | {
      kind: "broadcast";
      channel: ChannelId;
      action: "broadcast";
      handledBy: "core" | "dry-run";
      payload: {
        results: Array<{
          channel: ChannelId;
          to: string;
          ok: boolean;
          error?: string;
          attempted?: false;
          sentBeforeError?: true;
          payload?: unknown;
          result?: MessageSendResult;
        }>;
      };
      dryRun: boolean;
    }
  | {
      kind: "poll";
      channel: ChannelId;
      action: "poll";
      to: string;
      handledBy: "plugin" | "core";
      payload: unknown;
      toolResult?: AgentToolResult<unknown>;
      pollResult?: MessagePollResult;
      dryRun: boolean;
    }
  | {
      kind: "action";
      channel: ChannelId;
      action: Exclude<ChannelMessageActionName, "send" | "poll">;
      to?: string;
      handledBy: "plugin" | "dry-run";
      payload: unknown;
      toolResult?: AgentToolResult<unknown>;
      dryRun: boolean;
    };

function resolveMessageSendOutcome(
  sendResult: MessageSendResult | undefined,
  action: "Message" | "Broadcast" = "Message",
): { ok: true } | { ok: false; error: string; sentBeforeError?: true } {
  if (sendResult?.deliveryStatus === undefined || sendResult.deliveryStatus === "sent") {
    return { ok: true };
  }
  const status = sendResult.deliveryStatus;
  if (status === "suppressed" || status === "failed" || status === "partial_failed") {
    return {
      ok: false,
      error:
        status === "suppressed"
          ? `${action} send suppressed: ${sendResult.suppressionReason ?? "unknown reason"}.`
          : (sendResult.error ??
            `${action} send ${status === "failed" ? "failed" : "partially failed"}.`),
      ...(status === "partial_failed" || sendResult.sentBeforeError
        ? { sentBeforeError: true }
        : {}),
    };
  }
  return status satisfies never;
}

export function resolveMessageActionOutcome(
  result: MessageActionResult,
  action: "Message" | "Broadcast" = "Message",
): ReturnType<typeof resolveMessageSendOutcome> {
  if (result.kind === "broadcast") {
    const failure = result.payload.results.find((entry) => !entry.ok);
    return failure ? { ok: false, error: failure.error ?? "Broadcast failed." } : { ok: true };
  }
  if (result.dryRun) {
    return { ok: true };
  }
  const outcome =
    result.kind === "send"
      ? resolveMessageSendOutcome(result.sendResult, action)
      : { ok: true as const };
  const payload = result.payload;
  if (!outcome.ok || !isRecord(payload) || payload.ok !== false) {
    return outcome;
  }
  const error =
    [payload.error, payload.warning, payload.hint, payload.reason]
      .map(normalizeOptionalString)
      .find(Boolean) ?? `Message ${result.action} failed.`;
  return payload.sentBeforeError === true
    ? { ok: false, error, sentBeforeError: true }
    : { ok: false, error };
}

export function resolveMessageActionMessageId(payload: unknown): string | undefined {
  const record = asOptionalObjectRecord(payload);
  return (
    normalizeOptionalString(record?.messageId) ??
    normalizeOptionalString(asOptionalObjectRecord(record?.result)?.messageId)
  );
}

export type ResolvedActionContext = {
  cfg: OpenClawConfig;
  params: Record<string, unknown>;
  idempotencyKey?: string;
  channel: ChannelId;
  channelPlugin: ChannelPlugin;
  mediaAccess: OutboundMediaAccess;
  accountId?: string | null;
  dryRun: boolean;
  gateway?: MessageActionGateway;
  input: MessageActionInput;
  agentId?: string;
  resolvedTarget?: ResolvedMessagingTarget;
  abortSignal?: AbortSignal;
};

export function createChannelActionContext(params: {
  ctx: Omit<ResolvedActionContext, "mediaAccess"> & { mediaAccess?: OutboundMediaAccess };
  action: ChannelMessageActionContext["action"];
  mediaAccess?: OutboundMediaAccess;
  reply?: OutboundReplyFacts;
}): ChannelMessageActionContext {
  const mediaAccess = params.mediaAccess ?? params.ctx.mediaAccess;
  return {
    channel: params.ctx.channel,
    action: params.action,
    cfg: params.ctx.cfg,
    params: params.ctx.params,
    ...(params.reply ? { reply: params.reply } : {}),
    ...(mediaAccess ? { mediaAccess } : {}),
    mediaLocalRoots: mediaAccess?.localRoots,
    mediaReadFile: mediaAccess?.readFile,
    accountId: params.ctx.accountId ?? undefined,
    requesterAccountId: params.ctx.input.requesterAccountId ?? undefined,
    requesterSenderId: params.ctx.input.requesterSenderId ?? undefined,
    senderIsOwner: params.ctx.input.senderIsOwner,
    conversationReadOrigin: normalizeConversationReadInvocationOrigin(
      params.ctx.input.conversationReadOrigin,
    ),
    sessionKey: params.ctx.input.sessionKey,
    sessionId: params.ctx.input.sessionId,
    inboundEventKind: params.ctx.input.inboundEventKind,
    agentId: params.ctx.agentId,
    gateway: params.ctx.gateway,
    toolContext: params.ctx.input.toolContext,
    dryRun: params.ctx.dryRun,
    onPlatformSendDispatch: params.ctx.input.onPlatformSendDispatch,
    assertDirectAdapterHandoff: params.ctx.input.assertDirectAdapterHandoff,
    ...(params.action === "send" ? { skipQueue: params.ctx.input.skipQueue } : {}),
  };
}
