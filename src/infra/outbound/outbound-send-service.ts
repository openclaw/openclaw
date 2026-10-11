import { randomUUID } from "node:crypto";
import {
  projectPluginMessageDeliveryFact,
  type EmbeddedMessageDeliveryFact,
} from "../../agents/embedded-agent-message-delivery.js";
import type { AgentToolResult } from "../../agents/runtime/index.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { ChatType } from "../../channels/chat-type.js";
import type { OutboundReplyFacts } from "../../channels/message/types.js";
import { normalizeConversationReadInvocationOrigin } from "../../channels/plugins/conversation-read-origin.js";
import { dispatchChannelMessageAction } from "../../channels/plugins/message-action-dispatch.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import { isChannelPartialDeliveryError } from "../../channels/turn/partial-delivery-error.js";
import {
  normalizeMessagePresentation,
  renderMessagePresentationFallbackText,
} from "../../interactive/payload.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { OutboundMediaAccess } from "../../media/load-options.js";
import { resolveAgentScopedOutboundMediaAccess } from "../../media/read-capability.js";
import { extractToolPayload } from "../../plugin-sdk/tool-payload.js";
import { commitConfirmedVisibleMessage } from "../../sessions/confirmed-visible-message.js";
import { formatErrorMessage } from "../errors.js";
import { throwIfAborted } from "./abort.js";
import type { NormalizedOutboundPayload } from "./deliver.js";
import {
  createChannelActionContext,
  type ResolvedActionContext,
} from "./message-action-contracts.js";
import { collectActionMediaSourceHints } from "./message-action-params.js";
import type { MessagePollResult, MessageSendResult } from "./message.js";
import { sendMessage, sendPoll } from "./message.js";
import type { OutboundSessionRoute } from "./outbound-session.js";
import { buildOutboundSessionContext } from "./session-context.js";

const log = createSubsystemLogger("outbound/send-service");

type OutboundSendContext = Omit<ResolvedActionContext, "mediaAccess"> & {
  mediaAccess?: OutboundMediaAccess;
  conversationType?: ChatType;
  transcriptRoute?: OutboundSessionRoute;
  silent?: boolean;
  /** The caller resends proven-not-sent payloads itself, so recovery must not. */
  deliveryRetryOwner?: "caller";
  /** Commits first-contact routing after platform evidence. */
  onSendAccepted?: () => Promise<void>;
};

type PluginHandledResult = {
  handledBy: "plugin";
  payload: unknown;
  toolResult: AgentToolResult<unknown>;
};

export function materializeMessagePresentationFallback(params: {
  payload: Pick<ReplyPayload, "presentation" | "text">;
  text?: string;
}): string {
  const presentation = normalizeMessagePresentation(params.payload.presentation);
  const text = (params.text ?? params.payload.text ?? "").trim();
  const fallback = presentation ? renderMessagePresentationFallbackText({ presentation }) : "";
  return !fallback || text.includes(fallback)
    ? text
    : [text, fallback].filter(Boolean).join("\n\n");
}

export function hasCorePresentationDelivery(outbound?: ChannelOutboundAdapter): boolean {
  return Boolean(outbound?.sendPayload || outbound?.sendText || outbound?.sendFormattedText);
}

type SendActionParams = {
  ctx: OutboundSendContext;
  to: string;
  message: string;
  payload?: ReplyPayload;
  mediaUrl?: string;
  mediaUrls?: string[];
  buffer?: string;
  filename?: string;
  contentType?: string;
  asVoice?: boolean;
  gifPlayback?: boolean;
  forceDocument?: boolean;
  bestEffort?: boolean;
  reply?: OutboundReplyFacts;
  threadId?: string | number;
};

async function tryHandleWithPluginAction(params: {
  ctx: OutboundSendContext;
  action: "send" | "poll";
  reply?: OutboundReplyFacts;
  onHandled?: (deliveryFact: EmbeddedMessageDeliveryFact | undefined) => Promise<void> | void;
}): Promise<PluginHandledResult | null> {
  if (params.ctx.dryRun) {
    return null;
  }
  // Plugin actions receive media access scoped to the same requester/session
  // policy as core delivery so custom handlers cannot widen file reads.
  const mediaAccess = resolveAgentScopedOutboundMediaAccess({
    cfg: params.ctx.cfg,
    agentId: params.ctx.agentId,
    mediaSources: collectActionMediaSourceHints(params.ctx.params, undefined, {
      structuredAttachments: params.action === "send" ? "all" : undefined,
    }),
    sessionKey: params.ctx.input.sessionKey,
    messageProvider: params.ctx.input.sessionKey ? undefined : params.ctx.channel,
    accountId:
      (params.ctx.input.sessionKey
        ? (params.ctx.input.requesterAccountId ?? params.ctx.accountId)
        : params.ctx.accountId) ?? undefined,
    requesterSenderId: params.ctx.input.requesterSenderId ?? undefined,
    requesterSenderName: params.ctx.input.requesterSenderName ?? undefined,
    requesterSenderUsername: params.ctx.input.requesterSenderUsername ?? undefined,
    requesterSenderE164: params.ctx.input.requesterSenderE164 ?? undefined,
    mediaAccess: params.ctx.mediaAccess,
  });
  const handled = await dispatchChannelMessageAction(
    createChannelActionContext({
      ctx: params.ctx,
      action: params.action,
      mediaAccess,
      reply: params.reply,
    }),
  );
  if (!handled) {
    return null;
  }
  const deliveryFact = projectPluginMessageDeliveryFact(handled);
  if (!deliveryFact || deliveryFact.status === "settled") {
    await params.onHandled?.(deliveryFact);
  }
  return {
    handledBy: "plugin",
    payload: extractToolPayload(handled),
    toolResult: handled,
  };
}

export async function executeSendAction(params: SendActionParams): Promise<{
  handledBy: "plugin" | "core";
  payload: unknown;
  /** Exact text handed to the direct transport after core normalization and hooks. */
  deliveredText?: string;
  toolResult?: AgentToolResult<unknown>;
  sendResult?: MessageSendResult;
}> {
  throwIfAborted(params.ctx.abortSignal);
  const defaultPayload: ReplyPayload = params.payload ?? {
    text: params.message,
    mediaUrl: params.mediaUrl,
    mediaUrls: params.mediaUrls,
    audioAsVoice: params.asVoice === true,
  };
  const queuePolicy =
    params.bestEffort === false || params.ctx.input.requireQueuePersistence
      ? "required"
      : "best_effort";
  // Queue persistence cannot be guaranteed by provider-native action handlers.
  // Treat the guarantee as forcing the one core path at every dispatch gate.
  const requiresCoreDelivery =
    params.ctx.input.forceCoreDelivery === true ||
    params.ctx.input.requireQueuePersistence === true;
  const channelPlugin = params.ctx.channelPlugin;
  const prepareSendPayload =
    !requiresCoreDelivery && channelPlugin?.outbound
      ? channelPlugin.actions?.prepareSendPayload
      : undefined;
  const preparedPayload = prepareSendPayload
    ? await prepareSendPayload({
        ctx: createChannelActionContext({ ctx: params.ctx, action: "send", reply: params.reply }),
        to: params.to,
        payload: defaultPayload,
        replyToId: params.reply?.replyToId,
        replyToIdSource: params.reply?.source,
        threadId: params.threadId,
      })
    : undefined;
  const presentation = normalizeMessagePresentation(defaultPayload.presentation);
  // A hook that declines owns the plugin action path, including presentations.
  const corePayload = requiresCoreDelivery
    ? defaultPayload
    : preparedPayload ||
      (!prepareSendPayload && presentation && hasCorePresentationDelivery(channelPlugin?.outbound)
        ? defaultPayload
        : null);
  if (!corePayload) {
    const pluginMessage = presentation
      ? materializeMessagePresentationFallback({ payload: defaultPayload, text: params.message })
      : params.message;
    const pluginCtx =
      pluginMessage === params.message
        ? params.ctx
        : {
            ...params.ctx,
            params: { ...params.ctx.params, message: pluginMessage },
          };
    let pluginHandled: PluginHandledResult | null;
    try {
      pluginHandled = await tryHandleWithPluginAction({
        ctx: pluginCtx,
        action: "send",
        reply: params.reply,
        onHandled: async (deliveryFact) => {
          try {
            await params.ctx.onSendAccepted?.();
            if (!deliveryFact || deliveryFact.partialDelivery) {
              return;
            }
            if (deliveryFact.createdThreadIds.length > 1) {
              log.warn("Confirmed plugin outbound transcript skipped: multiple delivery threads");
              return;
            }
            const threadId = deliveryFact.createdThreadIds[0] ?? params.threadId;
            const threadChanged =
              threadId != null &&
              String(threadId) !== String(params.ctx.transcriptRoute?.threadId ?? params.threadId);
            const result = await commitConfirmedVisibleMessage({
              config: params.ctx.cfg,
              channel: params.ctx.channel,
              to: params.to,
              accountId: params.ctx.accountId ?? undefined,
              threadId,
              route: threadChanged ? undefined : params.ctx.transcriptRoute,
              producer: buildOutboundSessionContext({
                cfg: params.ctx.cfg,
                sessionKey: params.ctx.input.sessionKey,
                agentId: params.ctx.agentId,
              }),
              payload: { ...defaultPayload, text: pluginMessage },
              deliveryId:
                params.ctx.input.deliveryIntentId ?? params.ctx.idempotencyKey ?? randomUUID(),
              payloadIndex: 0,
              signal: params.ctx.abortSignal,
            });
            const diagnostic = result.ok ? result.diagnostics : result.reason;
            if (diagnostic) {
              log.warn(`Confirmed plugin outbound transcript: ${diagnostic}`);
            }
          } catch (error) {
            log.warn(
              `Confirmed plugin outbound transcript commit failed: ${formatErrorMessage(error)}`,
            );
          }
        },
      });
    } catch (error) {
      if (isChannelPartialDeliveryError(error)) {
        // A partial receipt proves the first-contact route even though it does
        // not prove which requested content is safe to mirror as delivered.
        await params.ctx.onSendAccepted?.();
      }
      throw error;
    }
    if (pluginHandled) {
      return pluginHandled;
    }
  }

  throwIfAborted(params.ctx.abortSignal);
  // Prepared payloads and presentations share core queueing, hooks, and transcript ownership.
  // The legacy gateway send RPC accepts text/media, so materialize its fallback.
  const message =
    corePayload &&
    normalizeMessagePresentation(corePayload.presentation) &&
    channelPlugin?.outbound?.deliveryMode === "gateway"
      ? materializeMessagePresentationFallback({ payload: corePayload, text: params.message })
      : params.message;
  const deliveredPayloads: NormalizedOutboundPayload[] = [];
  const result = await sendMessage({
    cfg: params.ctx.cfg,
    to: params.to,
    content: message,
    ...(corePayload ? { payloads: [corePayload] } : {}),
    agentId: params.ctx.agentId,
    requesterSessionKey: params.ctx.input.sessionKey,
    requesterAccountId: params.ctx.input.requesterAccountId ?? params.ctx.accountId ?? undefined,
    requesterSenderId: params.ctx.input.requesterSenderId ?? undefined,
    requesterSenderName: params.ctx.input.requesterSenderName ?? undefined,
    requesterSenderUsername: params.ctx.input.requesterSenderUsername ?? undefined,
    requesterSenderE164: params.ctx.input.requesterSenderE164 ?? undefined,
    mediaUrl: params.mediaUrl || undefined,
    mediaUrls: params.mediaUrls,
    buffer: params.buffer,
    filename: params.filename,
    contentType: params.contentType,
    asVoice: params.asVoice,
    channel: params.ctx.channel || undefined,
    accountId: params.ctx.accountId ?? undefined,
    conversationType: params.ctx.conversationType,
    conversationReadOrigin: normalizeConversationReadInvocationOrigin(
      params.ctx.input.conversationReadOrigin,
    ),
    reply: params.reply,
    threadId: params.threadId,
    gifPlayback: params.gifPlayback,
    forceDocument: params.forceDocument,
    dryRun: params.ctx.dryRun,
    bestEffort: params.bestEffort ?? undefined,
    queuePolicy,
    deps: params.ctx.input.deps,
    gateway: params.ctx.gateway,
    idempotencyKey: params.ctx.idempotencyKey,
    runId: params.ctx.input.runId,
    executionIdentityToken: params.ctx.input.executionIdentityToken,
    abortSignal: params.ctx.abortSignal,
    silent: params.ctx.silent,
    mediaAccess: params.ctx.mediaAccess,
    preparedMessageId: params.ctx.input.preparedMessageId,
    preparedPlugin: params.ctx.channelPlugin,
    gatewayOwnedDelivery: params.ctx.input.gatewayOwnedDelivery,
    deliveryIntentId: params.ctx.input.deliveryIntentId,
    deliveryCompletion: params.ctx.input.deliveryCompletion,
    transcriptRoute: params.ctx.transcriptRoute,
    conversationDeliveryTarget: params.ctx.input.conversationDeliveryTarget,
    deliveryRetryOwner: params.ctx.deliveryRetryOwner,
    requireUnknownSendReconciliation: params.ctx.input.requireQueuePersistence ? false : undefined,
    onDeliveryIntent: params.ctx.input.onDeliveryIntent,
    onDeliveryAttempt: params.ctx.input.onDeliveryAttempt,
    withDirectAdapterHandoff: params.ctx.input.withDirectAdapterHandoff,
    onDeliveryResult: async (evidence) => {
      await params.ctx.onSendAccepted?.();
      await params.ctx.input.onDeliveryResult?.(evidence);
    },
    onPlatformSendDispatch: params.ctx.input.onPlatformSendDispatch,
    assertDirectAdapterHandoff: params.ctx.input.assertDirectAdapterHandoff,
    skipQueue: params.ctx.input.skipQueue,
    onDeliveredPayload: (payload) => deliveredPayloads.push(payload),
  });
  const deliveredText =
    result.deliveryStatus === "sent" &&
    deliveredPayloads.every(
      (payload) => payload.mediaUrls.length === 0 && payload.audioAsVoice !== true,
    )
      ? deliveredPayloads
          .map((payload) => payload.text)
          .filter((text) => text.trim())
          .join("\n")
      : "";

  return {
    handledBy: "core",
    payload: result,
    ...(deliveredText ? { deliveredText } : {}),
    sendResult: result,
  };
}

export async function executePollAction(params: {
  ctx: OutboundSendContext;
  resolveCorePoll: () => {
    to: string;
    question: string;
    content?: string;
    options: string[];
    maxSelections: number;
    durationSeconds?: number;
    durationHours?: number;
    threadId?: string;
    isAnonymous?: boolean;
  };
}): Promise<{
  handledBy: "plugin" | "core";
  payload: unknown;
  toolResult?: AgentToolResult<unknown>;
  pollResult?: MessagePollResult;
}> {
  const pluginHandled = await tryHandleWithPluginAction({
    ctx: params.ctx,
    action: "poll",
  });
  if (pluginHandled) {
    return pluginHandled;
  }

  const corePoll = params.resolveCorePoll();
  const result: MessagePollResult = await sendPoll({
    ...corePoll,
    cfg: params.ctx.cfg,
    channel: params.ctx.channel,
    accountId: params.ctx.accountId ?? undefined,
    silent: params.ctx.silent ?? undefined,
    dryRun: params.ctx.dryRun,
    gateway: params.ctx.gateway,
    idempotencyKey: params.ctx.idempotencyKey,
    preparedPlugin: params.ctx.channelPlugin,
    gatewayOwnedDelivery: params.ctx.input.gatewayOwnedDelivery,
    sessionKey: params.ctx.input.sessionKey,
    inboundEventKind: params.ctx.input.inboundEventKind,
    onPlatformSendDispatch: params.ctx.input.onPlatformSendDispatch,
    assertDirectAdapterHandoff: params.ctx.input.assertDirectAdapterHandoff,
  });

  return {
    handledBy: "core",
    payload: result,
    pollResult: result,
  };
}
