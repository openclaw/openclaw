import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { ChatType } from "../../channels/chat-type.js";
import type { InboundEventKind } from "../../channels/inbound-event/kind.js";
import { deriveDurableFinalDeliveryRequirementsForBatch } from "../../channels/message/capabilities.js";
import {
  durableMessageBatchMayHaveReachedRecipient,
  sendDurableMessageBatchCore,
  serializeDurableMessagePayloadOutcomes,
  type DurableMessageBatchSendResult,
  type SerializedDurableMessagePayloadOutcome,
} from "../../channels/message/runtime.js";
import type { DurableMessageSendIntent } from "../../channels/message/types.js";
import type { AnyChannelPlugin as ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelPollResult } from "../../channels/plugins/types.public.js";
import { createChannelPartialDeliveryError } from "../../channels/turn/partial-delivery-error.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizePollInput } from "../../polls.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { formatErrorMessage } from "../errors.js";
import { resolveMessageChannelSelection } from "./channel-selection.js";
import type { DeliverOutboundPayloadsParams } from "./deliver-contracts.js";
import {
  assertOutboundHandoffCurrent,
  findOutboundHandoffRejectedError,
} from "./deliver-handoff.js";
import {
  resolveOutboundDurableFinalDeliverySupport,
  type OutboundDeliveryResult,
} from "./deliver.js";
import type { ConversationDeliveryTarget } from "./delivery-completion.js";
import {
  loadMessageGatewayRuntime,
  resolveGatewayIdempotencyKey,
  resolveOutboundMessageGatewayOptions,
  type OutboundMessageGatewayOptionsInput,
} from "./message-gateway-options.js";
import type { OutboundMirror } from "./mirror.js";
import {
  createOutboundPayloadPlan,
  projectOutboundPayloadPlanForDelivery,
  projectOutboundPayloadPlanForMirror,
} from "./payloads.js";
import { normalizeOutboundReplyFacts } from "./reply-policy.js";
import { buildOutboundSessionContext, type OutboundSessionContext } from "./session-context.js";
import { resolveOutboundTarget } from "./targets.js";

const SEND_BUFFER_MEDIA_URL = "buffer://message-send/attachment";

const loadMessageConfigRuntime = createLazyRuntimeModule(
  () => import("./message.config.runtime.js"),
);

type MessageSendParams = Pick<
  DeliverOutboundPayloadsParams,
  | "to"
  | "runId"
  | "executionIdentityToken"
  | "gifPlayback"
  | "forceDocument"
  | "accountId"
  | "conversationReadOrigin"
  | "reply"
  | "bestEffort"
  | "queuePolicy"
  | "mediaAccess"
  | "deps"
  | "preparedMessageId"
  | "deliveryIntentId"
  | "deliveryCompletion"
  | "reusePendingDeliveryIntent"
  | "deliveryRetryOwner"
  | "completionRetention"
  | "requireUnknownSendReconciliation"
  | "onDeliveryAttempt"
  | "withDirectAdapterHandoff"
  | "onDeliveryResult"
  | "onPlatformSendDispatch"
  | "assertDirectAdapterHandoff"
  | "skipQueue"
  | "onDeliveredPayload"
  | "abortSignal"
  | "silent"
> &
  Pick<
    OutboundSessionContext,
    | "agentId"
    | "requesterAccountId"
    | "requesterSenderId"
    | "requesterSenderName"
    | "requesterSenderUsername"
    | "requesterSenderE164"
  > & {
    content: string;
    /** Originating session key used for requester-scoped outbound media policy. */
    requesterSessionKey?: string;
    channel?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
    buffer?: string;
    filename?: string;
    contentType?: string;
    asVoice?: boolean;
    /** Known destination conversation kind prepared by the caller. */
    conversationType?: ChatType;
    replyToId?: string;
    threadId?: string | number;
    dryRun?: boolean;
    payloads?: ReplyPayload[];
    cfg?: OpenClawConfig;
    gateway?: OutboundMessageGatewayOptionsInput;
    idempotencyKey?: string;
    /** @internal Channel plugin already selected and bootstrapped by the caller. */
    preparedPlugin?: ChannelPlugin;
    /** @internal Use the active adapter directly when already executing inside the Gateway. */
    gatewayOwnedDelivery?: boolean;
    conversationDeliveryTarget?: ConversationDeliveryTarget;
    /** @internal Runs after queue persistence and before platform I/O. */
    onDeliveryIntent?: (intent: DurableMessageSendIntent) => void;
    mirror?: OutboundMirror;
    parseMode?: "HTML";
  };

export type MessageSendResult = {
  channel: string;
  to: string;
  via: "direct" | "gateway";
  mediaUrl: string | null;
  mediaUrls?: string[];
  result?: OutboundDeliveryResult | { messageId: string };
  deliveryStatus?: "sent" | "suppressed" | "partial_failed" | "failed";
  suppressionReason?: Extract<DurableMessageBatchSendResult, { status: "suppressed" }>["reason"];
  /** Formatted send error when deliveryStatus is "failed" or "partial_failed". */
  error?: string;
  sentBeforeError?: boolean;
  payloadOutcomes?: SerializedDurableMessagePayloadOutcome[];
  dryRun?: boolean;
};

type MessagePollParams = Pick<
  MessageSendParams,
  | "to"
  | "channel"
  | "accountId"
  | "silent"
  | "dryRun"
  | "cfg"
  | "gateway"
  | "idempotencyKey"
  | "onPlatformSendDispatch"
  | "assertDirectAdapterHandoff"
  | "preparedPlugin"
  | "gatewayOwnedDelivery"
> & {
  content?: string;
  question: string;
  options: string[];
  maxSelections?: number;
  durationSeconds?: number;
  durationHours?: number;
  threadId?: string;
  isAnonymous?: boolean;
  sessionKey?: string;
  inboundEventKind?: InboundEventKind;
};

export type MessagePollResult = {
  channel: string;
  to: string;
  question: string;
  options: string[];
  maxSelections: number;
  durationSeconds: number | null;
  durationHours: number | null;
  via: "direct" | "gateway";
  result?: Pick<OutboundDeliveryResult, "messageId" | "target" | "toJid" | "pollId" | "receipt">;
  dryRun?: boolean;
};

function normalizeMessagePollDeliveryResult(
  result: ChannelPollResult,
): NonNullable<MessagePollResult["result"]> {
  const { channelId, conversationId, ...delivery } = result;
  return {
    ...delivery,
    ...(channelId
      ? { target: { kind: "channel" as const, id: channelId } }
      : conversationId
        ? { target: { kind: "conversation" as const, id: conversationId } }
        : {}),
  };
}

async function callMessageGateway<T>(params: {
  gateway?: OutboundMessageGatewayOptionsInput;
  method: string;
  params: Record<string, unknown>;
  onPlatformSendDispatch?: () => Promise<void>;
  assertDirectAdapterHandoff?: () => void;
}): Promise<T> {
  const gateway = resolveOutboundMessageGatewayOptions(params.gateway);
  // Mint before the local dispatch fence so revocation during RPC is enforced
  // by the Gateway's live operational-run validator, not token freshness.
  const agentRuntimeIdentityToken = params.gateway?.request
    ? undefined
    : await params.gateway?.resolveAgentRuntimeIdentityToken?.();
  await params.onPlatformSendDispatch?.();
  assertOutboundHandoffCurrent(params.assertDirectAdapterHandoff);
  if (params.gateway?.request) {
    return await params.gateway.request<T>({
      method: params.method,
      params: params.params,
      timeoutMs: gateway.timeoutMs,
    });
  }
  const { callGatewayLeastPrivilege } = await loadMessageGatewayRuntime();
  return await callGatewayLeastPrivilege<T>({
    ...gateway,
    method: params.method,
    params: params.params,
    agentRuntimeIdentityToken,
  });
}

async function resolveMessageConfig(cfg?: OpenClawConfig): Promise<OpenClawConfig> {
  if (cfg) {
    return cfg;
  }
  const { getRuntimeConfig } = await loadMessageConfigRuntime();
  return getRuntimeConfig();
}

function resolveDirectMessageTarget(
  params: Pick<MessageSendParams, "to" | "accountId">,
  cfg: OpenClawConfig,
  channel: ChannelPlugin["id"],
  plugin: ChannelPlugin,
) {
  const target = resolveOutboundTarget({
    channel,
    plugin,
    to: params.to,
    cfg,
    accountId: params.accountId,
    mode: "explicit",
  });
  if (!target.ok) {
    throw target.error;
  }
  return target;
}

export async function sendMessage(params: MessageSendParams): Promise<MessageSendResult> {
  const cfg = await resolveMessageConfig(params.cfg);
  const reply = normalizeOutboundReplyFacts({ reply: params.reply, replyToId: params.replyToId });
  const { channel, plugin } = params.preparedPlugin
    ? { channel: params.preparedPlugin.id, plugin: params.preparedPlugin }
    : await resolveMessageChannelSelection({ cfg, channel: params.channel });
  const deliveryMode = plugin.outbound?.deliveryMode ?? "direct";
  const mediaSources = [params.mediaUrl, ...(params.mediaUrls ?? [])].filter(
    (source): source is string => Boolean(source),
  );
  const hasRealMediaSource = mediaSources.some((source) => source !== SEND_BUFFER_MEDIA_URL);
  const shouldForwardBuffer =
    deliveryMode === "gateway" && Boolean(params.buffer) && !hasRealMediaSource;
  const mediaUrl = params.mediaUrl ?? (shouldForwardBuffer ? SEND_BUFFER_MEDIA_URL : undefined);
  const mediaUrls = params.mediaUrls ?? (shouldForwardBuffer ? [SEND_BUFFER_MEDIA_URL] : undefined);
  const outboundPayloads =
    params.payloads && params.payloads.length > 0
      ? params.payloads
      : [
          {
            text: params.content,
            mediaUrl,
            mediaUrls,
            audioAsVoice: params.asVoice === true,
          },
        ];
  const outboundPlan = createOutboundPayloadPlan(outboundPayloads);
  const normalizedPayloads = projectOutboundPayloadPlanForDelivery(outboundPlan);
  const mirrorProjection = projectOutboundPayloadPlanForMirror(outboundPlan);
  const mirrorText = mirrorProjection.text;
  const mirrorMediaUrls = mirrorProjection.mediaUrls;
  const primaryMediaUrl = mirrorMediaUrls[0] ?? mediaUrl ?? null;
  const baseResult: MessageSendResult = {
    channel,
    to: params.to,
    via: deliveryMode === "gateway" ? "gateway" : "direct",
    mediaUrl: primaryMediaUrl,
    mediaUrls: mirrorMediaUrls.length ? mirrorMediaUrls : undefined,
  };

  if (params.dryRun) {
    return { ...baseResult, dryRun: true };
  }

  if (deliveryMode !== "gateway" || params.gatewayOwnedDelivery === true) {
    const resolvedTarget = resolveDirectMessageTarget(params, cfg, channel, plugin);

    const outboundSession = buildOutboundSessionContext({
      cfg,
      agentId: params.agentId,
      sessionKey: params.requesterSessionKey ?? params.mirror?.sessionKey,
      conversationType: params.conversationType,
      requesterAccountId: params.requesterAccountId ?? params.accountId,
      requesterSenderId: params.requesterSenderId,
      requesterSenderName: params.requesterSenderName,
      requesterSenderUsername: params.requesterSenderUsername,
      requesterSenderE164: params.requesterSenderE164,
    });
    // Public queuePolicy:"required" is the exact-delivery contract preflighted below.
    // Lower-level queue-required callers must leave this internal opt-in unset.
    const requireUnknownSendReconciliation =
      params.requireUnknownSendReconciliation ?? params.queuePolicy === "required";
    if (requireUnknownSendReconciliation) {
      const support = await resolveOutboundDurableFinalDeliverySupport({
        cfg,
        agentId: params.agentId,
        channel,
        requirements: deriveDurableFinalDeliveryRequirementsForBatch({
          payloads: normalizedPayloads,
          replyToId: reply?.replyToId,
          threadId: params.threadId,
          silent: params.silent,
          reconcileUnknownSend: true,
        }),
      });
      if (!support.ok) {
        const suffix =
          support.reason === "capability_mismatch" && support.capability
            ? `missing ${support.capability}`
            : support.reason;
        throw new Error(
          `Required durable message send is unsupported for ${channel}: ${suffix}. ` +
            'Use queuePolicy:"best_effort" for best-effort delivery, omit bestEffort:false in message-tool calls, or use a channel with required durable delivery support.',
        );
      }
    }
    const send = await sendDurableMessageBatchCore(
      {
        cfg,
        channel,
        to: resolvedTarget.to,
        session: outboundSession,
        runId: params.runId,
        executionIdentityToken: params.executionIdentityToken,
        accountId: params.accountId,
        conversationReadOrigin: params.conversationReadOrigin,
        payloads: normalizedPayloads,
        reply,
        threadId: params.threadId,
        gifPlayback: params.gifPlayback,
        forceDocument: params.forceDocument,
        deps: params.deps,
        bestEffort: params.bestEffort,
        ...(requireUnknownSendReconciliation ? { requireUnknownSendReconciliation: true } : {}),
        durability:
          params.bestEffort || params.queuePolicy === "best_effort" ? "best_effort" : "required",
        signal: params.abortSignal,
        silent: params.silent,
        mediaAccess: params.mediaAccess,
        formatting: params.parseMode ? { parseMode: params.parseMode } : undefined,
        preparedMessageId: params.preparedMessageId,
        deliveryIntentId: params.deliveryIntentId,
        deliveryCompletion: params.deliveryCompletion,
        reusePendingDeliveryIntent: params.reusePendingDeliveryIntent,
        deliveryRetryOwner: params.deliveryRetryOwner,
        completionRetention: params.completionRetention,
        ...(params.onDeliveryIntent ? { onDeliveryIntent: params.onDeliveryIntent } : {}),
        ...(params.onDeliveryAttempt ? { onDeliveryAttempt: params.onDeliveryAttempt } : {}),
        withDirectAdapterHandoff: params.withDirectAdapterHandoff,
        ...(params.onDeliveryResult ? { onDeliveryResult: params.onDeliveryResult } : {}),
        ...(params.onPlatformSendDispatch
          ? { onPlatformSendDispatch: params.onPlatformSendDispatch }
          : {}),
        assertDirectAdapterHandoff: params.assertDirectAdapterHandoff,
        skipQueue: params.skipQueue,
        ...(params.onDeliveredPayload ? { onDeliveredPayload: params.onDeliveredPayload } : {}),
        mirror: params.mirror
          ? {
              ...params.mirror,
              text: mirrorText || params.content,
              mediaUrls: mirrorMediaUrls.length ? mirrorMediaUrls : undefined,
              idempotencyKey: params.mirror.idempotencyKey ?? params.idempotencyKey,
            }
          : undefined,
      },
      params.conversationDeliveryTarget,
    );
    const sendMayHaveReachedRecipient = durableMessageBatchMayHaveReachedRecipient(send);
    const handoffRejection =
      send.status === "failed" && !sendMayHaveReachedRecipient
        ? (send.payloadOutcomes
            ?.map((outcome) =>
              outcome.status === "failed"
                ? findOutboundHandoffRejectedError(outcome.error)
                : undefined,
            )
            .find((error) => error !== undefined) ?? findOutboundHandoffRejectedError(send.error))
        : undefined;
    if (handoffRejection) {
      // Keep the final host handoff fact intact for both ordinary and
      // best-effort callers instead of normalizing it into a provider result.
      throw handoffRejection;
    }
    const shouldThrowFailure =
      !params.bestEffort && params.gateway?.clientName !== GATEWAY_CLIENT_NAMES.CLI;
    if (shouldThrowFailure && (send.status === "failed" || send.status === "partial_failed")) {
      if (send.status === "partial_failed") {
        throw createChannelPartialDeliveryError(send.error, {
          messageIds: send.results.map((result) => result.messageId),
          receipt: send.receipt,
          visibleReplySent: true,
        });
      }
      throw send.error;
    }
    const results = send.status === "sent" || send.status === "partial_failed" ? send.results : [];
    const payloadOutcomes = serializeDurableMessagePayloadOutcomes(send.payloadOutcomes);
    const sentBeforeError = send.status !== "sent" && sendMayHaveReachedRecipient;

    return {
      ...baseResult,
      result: results.at(-1),
      deliveryStatus: send.status,
      ...(send.status === "suppressed" ? { suppressionReason: send.reason } : {}),
      ...(send.status === "failed" || send.status === "partial_failed"
        ? { error: formatErrorMessage(send.error) }
        : {}),
      ...(sentBeforeError ? { sentBeforeError: true as const } : {}),
      ...(payloadOutcomes ? { payloadOutcomes } : {}),
    };
  }

  const result = await callMessageGateway<{ messageId: string }>({
    gateway: params.gateway,
    method: "send",
    onPlatformSendDispatch: params.onPlatformSendDispatch,
    assertDirectAdapterHandoff: params.assertDirectAdapterHandoff,
    params: {
      to: params.to,
      message: params.content,
      mediaUrl,
      mediaUrls: mirrorMediaUrls.length ? mirrorMediaUrls : mediaUrls,
      buffer: shouldForwardBuffer ? params.buffer : undefined,
      filename: shouldForwardBuffer ? params.filename : undefined,
      contentType: shouldForwardBuffer ? params.contentType : undefined,
      asVoice: params.asVoice,
      gifPlayback: params.gifPlayback,
      accountId: params.accountId,
      agentId: params.agentId,
      channel,
      replyToId: reply?.replyToId,
      threadId: params.threadId != null ? String(params.threadId) : undefined,
      forceDocument: params.forceDocument,
      silent: params.silent,
      parseMode: params.parseMode,
      sessionKey: params.mirror?.sessionKey,
      idempotencyKey: await resolveGatewayIdempotencyKey(params.idempotencyKey),
    },
  });

  return { ...baseResult, result };
}

export async function sendPoll(params: MessagePollParams): Promise<MessagePollResult> {
  const cfg = await resolveMessageConfig(params.cfg);
  const { channel, plugin } = params.preparedPlugin
    ? { channel: params.preparedPlugin.id, plugin: params.preparedPlugin }
    : await resolveMessageChannelSelection({ cfg, channel: params.channel });

  const outbound = plugin.outbound;
  if (!outbound?.sendPoll) {
    throw new Error(`Unsupported poll channel: ${channel}`);
  }
  const deliveryMode = outbound.deliveryMode ?? "direct";
  const normalized = normalizePollInput(
    params,
    outbound.pollMaxOptions ? { maxOptions: outbound.pollMaxOptions } : undefined,
  );
  const buildResult = (
    delivery: Pick<MessagePollResult, "result" | "dryRun">,
  ): MessagePollResult => ({
    channel,
    to: params.to,
    question: normalized.question,
    options: normalized.options,
    maxSelections: normalized.maxSelections,
    durationSeconds: normalized.durationSeconds ?? null,
    durationHours: normalized.durationHours ?? null,
    via: deliveryMode === "gateway" ? "gateway" : "direct",
    ...delivery,
  });

  if (params.dryRun) {
    return buildResult({ dryRun: true });
  }

  if (typeof params.durationSeconds === "number" && outbound.supportsPollDurationSeconds !== true) {
    throw new Error(`durationSeconds is not supported for ${channel} polls`);
  }
  if (typeof params.isAnonymous === "boolean" && outbound.supportsAnonymousPolls !== true) {
    throw new Error(`isAnonymous is not supported for ${channel} polls`);
  }

  if (deliveryMode !== "gateway" || params.gatewayOwnedDelivery === true) {
    const resolvedTarget = resolveDirectMessageTarget(params, cfg, channel, plugin);

    params.assertDirectAdapterHandoff?.();
    const result = await outbound.sendPoll({
      cfg,
      to: resolvedTarget.to,
      poll: normalized,
      content: params.content,
      accountId: params.accountId,
      threadId: params.threadId,
      silent: params.silent,
      isAnonymous: params.isAnonymous,
      sessionKey: params.sessionKey,
      inboundEventKind: params.inboundEventKind,
      onPlatformSendDispatch: params.onPlatformSendDispatch,
      assertDirectAdapterHandoff: params.assertDirectAdapterHandoff,
    });

    return buildResult({ result: normalizeMessagePollDeliveryResult(result) });
  }

  const result = await callMessageGateway<ChannelPollResult>({
    gateway: params.gateway,
    method: "poll",
    onPlatformSendDispatch: params.onPlatformSendDispatch,
    assertDirectAdapterHandoff: params.assertDirectAdapterHandoff,
    params: {
      ...normalized,
      to: params.to,
      threadId: params.threadId,
      silent: params.silent,
      isAnonymous: params.isAnonymous,
      channel,
      accountId: params.accountId,
      idempotencyKey: await resolveGatewayIdempotencyKey(params.idempotencyKey),
    },
  });

  return buildResult({ result: normalizeMessagePollDeliveryResult(result) });
}
