import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentIdentity, resolveResponsePrefix } from "../../agents/identity.js";
import { readStringParam } from "../../agents/tools/common.js";
import { resolveResponsePrefixTemplate } from "../../auto-reply/reply/response-prefix-template.js";
import { normalizeConversationReadInvocationOrigin } from "../../channels/plugins/conversation-read-origin.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OutboundMediaAccess } from "../../media/load-options.js";
import { resolveOutboundChannelPlugin } from "./channel-resolution.js";
import { MAX_OUTBOUND_DELIVERY_POLICY_REROUTES } from "./delivery-policy-hook.js";
import {
  applySendPayloadPartsToActionParams,
  buildPortableMessageActionReroutePayload,
  resolveMessageActionDeliveryPolicyStep,
  resolveMessageActionPolicySource,
  type SendPayloadParts,
  updateSendPayloadPartsFromReplyPayload,
} from "./message-action-delivery-policy.js";
import type {
  MessageActionRunnerGateway,
  RunMessageActionParams,
} from "./message-action-runner.js";
import { prepareOutboundMirrorRoute } from "./message-action-threading.js";
import { maybeApplyTtsToMessageActionSendPayload } from "./message-action-tts.js";
import {
  executeSendAction,
  hasCorePresentationDelivery,
  materializeMessagePresentationFallback,
} from "./outbound-send-service.js";
import {
  ensureOutboundSessionEntry,
  resolveOutboundSessionRoute,
  type OutboundSessionRoute,
} from "./outbound-session.js";
import type { ResolvedMessagingTarget } from "./target-resolver.js";

export type MessageActionPolicyState = {
  actionParams: Record<string, unknown>;
  channel: ChannelId;
  to: string;
  accountId?: string | null;
  threadId?: string | number;
  sendPayload: SendPayloadParts;
  resolvedTarget?: ResolvedMessagingTarget;
  appliedResponsePrefix?: string;
};

const UNRESOLVED_PREFIX_VAR_PATTERN = /\{[a-zA-Z][a-zA-Z0-9.]*\}/;

/** Apply the response prefix and TTS transformation before final policy evaluation. */
export async function prepareMessageActionFinalPayload(params: {
  cfg: OpenClawConfig;
  input: RunMessageActionParams;
  state: MessageActionPolicyState;
  agentId?: string;
  dryRun: boolean;
}) {
  const { state } = params;
  const previousPrefix = state.appliedResponsePrefix;
  if (previousPrefix && state.sendPayload.message.startsWith(`${previousPrefix} `)) {
    const message = state.sendPayload.message.slice(previousPrefix.length + 1);
    state.sendPayload = {
      ...state.sendPayload,
      message,
      payload: { ...state.sendPayload.payload, text: message },
    };
    applySendPayloadPartsToActionParams(state.actionParams, state.sendPayload);
  }
  state.appliedResponsePrefix = undefined;
  const responsePrefix = resolveResponsePrefixTemplate(
    resolveResponsePrefix(params.cfg, params.agentId ?? "", {
      channel: state.channel,
      accountId: state.accountId ?? undefined,
    }),
    {
      identityName: normalizeOptionalString(
        resolveAgentIdentity(params.cfg, params.agentId ?? "")?.name,
      ),
    },
  );
  if (
    responsePrefix &&
    !UNRESOLVED_PREFIX_VAR_PATTERN.test(responsePrefix) &&
    state.sendPayload.message &&
    !state.sendPayload.message.startsWith(responsePrefix)
  ) {
    const message = `${responsePrefix} ${state.sendPayload.message}`;
    state.sendPayload = {
      ...state.sendPayload,
      message,
      payload: { ...state.sendPayload.payload, text: message },
    };
    state.appliedResponsePrefix = responsePrefix;
    applySendPayloadPartsToActionParams(state.actionParams, state.sendPayload);
  }

  const ttsPayload = await maybeApplyTtsToMessageActionSendPayload({
    payload: state.sendPayload.payload,
    cfg: params.cfg,
    channel: state.channel,
    accountId: state.accountId,
    agentId: params.agentId,
    sessionKey: params.input.sessionKey,
    inboundAudio: params.input.inboundAudio,
    dryRun: params.dryRun,
  });
  if (ttsPayload !== state.sendPayload.payload) {
    state.sendPayload = updateSendPayloadPartsFromReplyPayload(state.sendPayload, ttsPayload);
    applySendPayloadPartsToActionParams(state.actionParams, state.sendPayload);
  }
}

/** Restore reply-to-first bookkeeping when policy prevents a source reply. */
export function captureMessageActionReplyState(input: RunMessageActionParams): () => void {
  const repliedRef = input.toolContext?.hasRepliedRef;
  const previous = repliedRef?.value;
  return () => {
    if (repliedRef && previous !== undefined) {
      repliedRef.value = previous;
    }
  };
}

/** Owns repeated final-payload policy checks for one message-tool send. */
export function createMessageActionPolicyBoundary(params: {
  input: RunMessageActionParams;
  state: MessageActionPolicyState;
}) {
  const state = params.state;
  return {
    source: resolveMessageActionPolicySource(params.input),
    state,
    recheck: async () => {
      const result = await resolveMessageActionDeliveryPolicyStep({
        actionParams: state.actionParams,
        channel: state.channel,
        to: state.to,
        accountId: state.accountId,
        threadId: state.threadId,
        sendPayload: state.sendPayload,
        input: params.input,
      });
      if (result.status === "cancel") {
        return result;
      }
      state.actionParams = result.params;
      state.channel = result.channel;
      state.to = result.to;
      state.accountId = result.accountId;
      state.threadId = result.threadId;
      state.sendPayload = result.sendPayload;
      if (result.rerouted) {
        state.resolvedTarget = undefined;
      }
      return result;
    },
  };
}

function makeMessageActionPolicyPayloadPortable(state: MessageActionPolicyState): void {
  const portablePayload = buildPortableMessageActionReroutePayload({
    payload: state.sendPayload.payload,
    appliedResponsePrefix: state.appliedResponsePrefix,
  });
  state.sendPayload = updateSendPayloadPartsFromReplyPayload(state.sendPayload, portablePayload);
  state.appliedResponsePrefix = undefined;
  applySendPayloadPartsToActionParams(state.actionParams, state.sendPayload);
}

/** Materialize legacy presentation text before the last policy decision. */
export async function applyMessageActionPresentationFallbackPolicy(params: {
  boundary: ReturnType<typeof createMessageActionPolicyBoundary>;
  cfg: OpenClawConfig;
}) {
  const { state } = params.boundary;
  const presentation = state.sendPayload.payload.presentation;
  const outbound = resolveOutboundChannelPlugin({
    channel: state.channel,
    cfg: params.cfg,
  })?.outbound;
  if (
    !presentation ||
    (outbound?.deliveryMode !== "gateway" && hasCorePresentationDelivery(outbound))
  ) {
    return undefined;
  }
  const message = materializeMessagePresentationFallback({
    payload: state.sendPayload.payload,
    text: state.sendPayload.message,
  });
  state.sendPayload = {
    ...state.sendPayload,
    message,
    payload: { ...state.sendPayload.payload, text: message },
  };
  applySendPayloadPartsToActionParams(state.actionParams, state.sendPayload);
  const result = await params.boundary.recheck();
  if (result.status === "reroute") {
    makeMessageActionPolicyPayloadPortable(state);
  }
  return result;
}

/** Converge destination-aware payload preparation and policy reroutes. */
export async function settleMessageActionFinalPayloadPolicy(params: {
  boundary: ReturnType<typeof createMessageActionPolicyBoundary>;
  cfg: OpenClawConfig;
  input: RunMessageActionParams;
  agentId?: string;
  dryRun: boolean;
}) {
  let rerouted = false;
  for (let depth = 0; depth <= MAX_OUTBOUND_DELIVERY_POLICY_REROUTES; depth += 1) {
    await prepareMessageActionFinalPayload({
      cfg: params.cfg,
      input: params.input,
      state: params.boundary.state,
      agentId: params.agentId,
      dryRun: params.dryRun,
    });
    const result = await params.boundary.recheck();
    if (result.status === "cancel") {
      return result;
    }
    rerouted ||= result.rerouted;
    if (!result.rerouted) {
      return { ...result, rerouted };
    }
    makeMessageActionPolicyPayloadPortable(params.boundary.state);
  }
  throw new Error("Outbound delivery policy reroute depth exceeded.");
}

/** Restore first-reply state when a terminal delivery produced no visible send. */
export async function executeMessageActionPolicyDelivery<
  T extends { sendResult?: { deliveryStatus?: string } },
>(params: { execute: () => Promise<T>; restoreSourceReplyState: () => void }): Promise<T> {
  const result = await params.execute();
  if (result.sendResult?.deliveryStatus === "suppressed") {
    params.restoreSourceReplyState();
  }
  return result;
}

/** Execute the fully prepared message-action send while preserving policy metadata. */
export async function executePreparedMessageActionPolicySend(params: {
  boundary: ReturnType<typeof createMessageActionPolicyBoundary>;
  input: RunMessageActionParams;
  cfg: OpenClawConfig;
  agentId?: string;
  dryRun: boolean;
  gateway?: MessageActionRunnerGateway;
  mediaAccess: OutboundMediaAccess;
  outboundRoute: OutboundSessionRoute | null;
  resolvedReplyToId?: string;
  resolvedThreadId?: string;
  replyToIsExplicit: boolean;
  restoreSourceReplyState: () => void;
}) {
  const { state } = params.boundary;
  const requiresCoreDelivery =
    params.input.forceCoreDelivery === true || params.input.requireQueuePersistence === true;
  return await executeMessageActionPolicyDelivery({
    restoreSourceReplyState: params.restoreSourceReplyState,
    execute: async () =>
      await executeSendAction({
        ctx: {
          cfg: params.cfg,
          channel: state.channel,
          params: state.actionParams,
          agentId: params.agentId,
          sessionKey: params.input.sessionKey,
          requesterAccountId: params.input.requesterAccountId ?? undefined,
          requesterSenderId: params.input.requesterSenderId ?? undefined,
          requesterSenderName: params.input.requesterSenderName ?? undefined,
          requesterSenderUsername: params.input.requesterSenderUsername ?? undefined,
          requesterSenderE164: params.input.requesterSenderE164 ?? undefined,
          senderIsOwner: params.input.senderIsOwner,
          conversationReadOrigin: normalizeConversationReadInvocationOrigin(
            params.input.conversationReadOrigin,
          ),
          mediaAccess: params.mediaAccess,
          accountId: state.accountId ?? undefined,
          conversationType: params.outboundRoute?.chatType,
          sessionId: params.input.sessionId,
          inboundEventKind: params.input.inboundEventKind,
          gateway: params.gateway,
          toolContext: params.input.toolContext,
          deps: params.input.deps,
          dryRun: params.dryRun,
          preparedMessageId: params.input.preparedMessageId,
          gatewayOwnedDelivery: params.input.gatewayOwnedDelivery,
          forceCoreDelivery: requiresCoreDelivery,
          requireQueuePersistence: params.input.requireQueuePersistence,
          deliveryIntentId: params.input.deliveryIntentId,
          deliveryCompletion: params.input.deliveryCompletion,
          onDeliveryIntent: params.input.onDeliveryIntent,
          onDeliveryResult: params.input.onDeliveryResult,
          deliveryPolicy: {
            path: "message_action",
            action: "send",
            source: params.boundary.source,
          },
          skipInitialOutboundDeliveryPolicy: true,
          mirror:
            !params.dryRun && params.input.transcriptMirror
              ? {
                  ...params.input.transcriptMirror,
                  text: state.sendPayload.message,
                  mediaUrls: state.sendPayload.mediaUrls,
                }
              : params.outboundRoute &&
                  !params.dryRun &&
                  params.input.suppressTranscriptMirror !== true
                ? {
                    sessionKey: params.outboundRoute.sessionKey,
                    agentId: params.agentId,
                    text: state.sendPayload.message,
                    mediaUrls: state.sendPayload.mediaUrls,
                    idempotencyKey:
                      normalizeOptionalString(state.actionParams.idempotencyKey) ?? undefined,
                  }
                : undefined,
          abortSignal: params.input.abortSignal,
          silent: state.sendPayload.silent ?? undefined,
        },
        to: state.to,
        message: state.sendPayload.message,
        payload: state.sendPayload.payload,
        mediaUrl: state.sendPayload.mediaUrl,
        mediaUrls: state.sendPayload.mediaUrls,
        buffer: readStringParam(state.actionParams, "buffer", { trim: false }) ?? undefined,
        filename: readStringParam(state.actionParams, "filename") ?? undefined,
        contentType: readStringParam(state.actionParams, "contentType") ?? undefined,
        asVoice: state.sendPayload.asVoice,
        gifPlayback: state.sendPayload.gifPlayback,
        forceDocument: state.sendPayload.forceDocument,
        bestEffort: state.sendPayload.bestEffort,
        replyToId: params.resolvedReplyToId,
        replyToIdSource: params.resolvedReplyToId
          ? params.replyToIsExplicit
            ? "explicit"
            : "implicit"
          : undefined,
        threadId: state.threadId ?? params.resolvedThreadId,
      }),
  });
}

/** Build the standard suppressed result returned by message-tool policy cancellation. */
export function buildMessageActionPolicySuppression(params: {
  channel: ChannelId;
  to: string;
  reason?: string;
  dryRun: boolean;
}) {
  return {
    kind: "send" as const,
    channel: params.channel,
    action: "send" as const,
    to: params.to,
    handledBy: "core" as const,
    payload: {
      status: "suppressed",
      reason: "cancelled_by_outbound_delivery_policy",
      ...(params.reason ? { hookReason: params.reason } : {}),
    },
    dryRun: params.dryRun,
  };
}

/** Resolve mirror and reply metadata from the policy-approved destination. */
export async function prepareMessageActionPolicyMirrorRoute(params: {
  cfg: OpenClawConfig;
  input: RunMessageActionParams;
  state: MessageActionPolicyState;
  agentId?: string;
  dryRun: boolean;
  replyToIsExplicit: boolean;
}) {
  const { state } = params;
  const route = await prepareOutboundMirrorRoute({
    cfg: params.cfg,
    channel: state.channel,
    to: state.to,
    actionParams: state.actionParams,
    accountId: state.accountId,
    toolContext: params.input.toolContext,
    agentId: params.agentId,
    currentSessionKey: params.input.sessionKey,
    dryRun: params.dryRun,
    resolvedTarget: state.resolvedTarget,
    resolveAutoThreadId: getChannelPlugin(state.channel)?.threading?.resolveAutoThreadId,
    resolveReplyTransport: getChannelPlugin(state.channel)?.threading?.resolveReplyTransport,
    replyToIsExplicit: params.replyToIsExplicit,
    resolveOutboundSessionRoute,
    ensureOutboundSessionEntry,
  });
  return {
    ...route,
    resolvedReplyToId: readStringParam(state.actionParams, "replyTo"),
  };
}
