import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import {
  MAX_OUTBOUND_DELIVERY_POLICY_REROUTES,
  runOutboundDeliveryPolicyHook,
  type OutboundDeliveryPolicySource,
} from "./delivery-policy-hook.js";
import type { RunMessageActionParams } from "./message-action-runner.js";

export type SendPayloadParts = {
  message: string;
  payload: ReplyPayload;
  mediaUrl?: string;
  mediaUrls?: string[];
  asVoice: boolean;
  gifPlayback: boolean;
  forceDocument: boolean;
  bestEffort?: boolean;
  silent?: boolean;
};

type PolicyResolvedSend = {
  status: "allow";
  channel: ChannelId;
  to: string;
  accountId?: string | null;
  threadId?: string | number;
  params: Record<string, unknown>;
  sendPayload: SendPayloadParts;
  rerouted: boolean;
};

type PolicyCancelledSend = {
  status: "cancel";
  channel: ChannelId;
  to: string;
  reason?: string;
  sendPayload: SendPayloadParts;
};

type InternalSourcePolicyResult =
  | { status: "allow"; sendPayload: SendPayloadParts }
  | PolicyCancelledSend
  | { status: "reroute"; params: Record<string, unknown>; sendPayload: SendPayloadParts };

/** Apply a plugin-visible reply payload to the message action send shape. */
export function updateSendPayloadPartsFromReplyPayload(
  parts: SendPayloadParts,
  payload: ReplyPayload,
): SendPayloadParts {
  const sendable = resolveSendableOutboundReplyParts(payload);
  const mediaUrls = sendable.mediaUrls.length > 0 ? sendable.mediaUrls : undefined;
  return {
    ...parts,
    message: payload.text ?? "",
    payload,
    mediaUrl: mediaUrls?.[0],
    mediaUrls,
    asVoice: payload.audioAsVoice === true,
  };
}

/** Copy policy-adjusted send fields back to normalized message action params. */
export function applySendPayloadPartsToActionParams(
  actionParams: Record<string, unknown>,
  parts: SendPayloadParts,
): void {
  const applyOptional = (key: string, value: unknown) => {
    if (value === undefined) {
      delete actionParams[key];
    } else {
      actionParams[key] = value;
    }
  };
  if (parts.message || !parts.payload.presentation) {
    actionParams.message = parts.message;
  } else {
    // Presentation-only handlers distinguish an omitted body from an explicit empty body.
    delete actionParams.message;
  }
  applyOptional("media", parts.mediaUrl);
  applyOptional("mediaUrl", parts.mediaUrl);
  applyOptional("mediaUrls", parts.mediaUrls);
  applyOptional("asVoice", parts.asVoice || undefined);
  applyOptional("audioAsVoice", parts.asVoice || undefined);
  applyOptional("asVideoNote", parts.payload.videoAsNote || undefined);
  applyOptional("location", parts.payload.location);
  applyOptional("presentation", parts.payload.presentation);
  applyOptional("interactive", parts.payload.interactive);
  applyOptional("delivery", parts.payload.delivery);
  applyOptional("channelData", parts.payload.channelData);
}

function sourceFromMessageActionInput(input: RunMessageActionParams): OutboundDeliveryPolicySource {
  const currentChannel = normalizeOptionalLowercaseString(
    input.toolContext?.currentChannelProvider,
  );
  const currentTarget = normalizeOptionalString(input.toolContext?.currentChannelId);
  const currentThreadId =
    normalizeOptionalString(input.toolContext?.currentThreadTs) ??
    input.toolContext?.currentMessageId;
  return {
    ...(currentChannel ? { channel: currentChannel } : {}),
    ...(currentTarget ? { conversationId: currentTarget } : {}),
    ...(input.requesterAccountId ? { accountId: input.requesterAccountId } : {}),
    ...(input.requesterSenderId ? { senderId: input.requesterSenderId } : {}),
    ...(currentThreadId !== undefined ? { threadId: currentThreadId } : {}),
    ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
    ...(input.inboundEventKind ? { inboundEventKind: input.inboundEventKind } : {}),
  };
}

/** Apply outbound delivery policy to an explicit message send. */
export async function resolveMessageActionDeliveryPolicy(params: {
  actionParams: Record<string, unknown>;
  channel: ChannelId;
  to: string;
  accountId?: string | null;
  threadId?: string | number;
  sendPayload: SendPayloadParts;
  input: RunMessageActionParams;
}): Promise<PolicyResolvedSend | PolicyCancelledSend> {
  let channel = params.channel;
  let to = params.to;
  let accountId = params.accountId;
  let threadId = params.threadId;
  let actionParams = params.actionParams;
  let sendPayload = params.sendPayload;
  let rerouted = false;
  const copyActionParams = (): Record<string, unknown> => Object.assign({}, actionParams);

  for (let depth = 0; depth <= MAX_OUTBOUND_DELIVERY_POLICY_REROUTES; depth += 1) {
    const decision = await runOutboundDeliveryPolicyHook({
      payload: sendPayload.payload,
      kind: "message_action",
      action: "send",
      source: sourceFromMessageActionInput(params.input),
      destination: {
        channel,
        to,
        ...(accountId ? { accountId } : {}),
        ...(threadId !== undefined ? { threadId } : {}),
        path: "message_action",
      },
      ...(params.input.sessionKey ? { sessionKey: params.input.sessionKey } : {}),
    });

    const payloadChanged = decision.payload !== sendPayload.payload;
    sendPayload = payloadChanged
      ? updateSendPayloadPartsFromReplyPayload(sendPayload, decision.payload)
      : sendPayload;
    if (payloadChanged) {
      actionParams = copyActionParams();
      applySendPayloadPartsToActionParams(actionParams, sendPayload);
    }
    if (decision.decision === "cancel") {
      return {
        status: "cancel",
        channel,
        to,
        ...(decision.reason ? { reason: decision.reason } : {}),
        sendPayload,
      };
    }
    if (decision.decision !== "reroute") {
      return {
        status: "allow",
        channel,
        to,
        ...(accountId ? { accountId } : {}),
        ...(threadId !== undefined ? { threadId } : {}),
        params: actionParams,
        sendPayload,
        rerouted,
      };
    }

    rerouted = true;
    channel = decision.destination.channel as ChannelId;
    to = decision.destination.to;
    accountId = decision.destination.accountId;
    threadId = decision.destination.threadId;
    actionParams = copyActionParams();
    Object.assign(actionParams, { channel, to, target: to });
    if (accountId) {
      actionParams.accountId = accountId;
    } else {
      delete actionParams.accountId;
    }
    if (threadId !== undefined) {
      actionParams.threadId = threadId;
    } else {
      delete actionParams.threadId;
    }
    delete actionParams.replyTo;
    applySendPayloadPartsToActionParams(actionParams, sendPayload);
  }
  throw new Error("Outbound delivery policy reroute depth exceeded.");
}

function resolveInternalSourceDestination(input: RunMessageActionParams): {
  channel: ChannelId;
  to: string;
  threadId?: string | number;
} {
  const channel =
    normalizeOptionalLowercaseString(input.toolContext?.currentChannelProvider) ??
    INTERNAL_MESSAGE_CHANNEL;
  const to = normalizeOptionalString(input.toolContext?.currentChannelId) ?? "current-run";
  const threadId =
    normalizeOptionalString(input.toolContext?.currentThreadTs) ??
    input.toolContext?.currentMessageId;
  return { channel, to, ...(threadId !== undefined ? { threadId } : {}) };
}

/** Apply outbound policy before an internal-source fallback becomes visible. */
export async function resolveInternalSourceReplyDeliveryPolicy(params: {
  actionParams: Record<string, unknown>;
  sendPayload: SendPayloadParts;
  input: RunMessageActionParams;
}): Promise<InternalSourcePolicyResult> {
  const destination = resolveInternalSourceDestination(params.input);
  const decision = await runOutboundDeliveryPolicyHook({
    payload: params.sendPayload.payload,
    kind: "message_action",
    action: "send",
    source: sourceFromMessageActionInput(params.input),
    destination: {
      channel: destination.channel,
      to: destination.to,
      ...(destination.threadId !== undefined ? { threadId: destination.threadId } : {}),
      path: "internal_source",
    },
    ...(params.input.sessionKey ? { sessionKey: params.input.sessionKey } : {}),
  });
  const sendPayload =
    decision.payload !== params.sendPayload.payload
      ? updateSendPayloadPartsFromReplyPayload(params.sendPayload, decision.payload)
      : params.sendPayload;
  if (decision.decision === "cancel") {
    return {
      status: "cancel",
      channel: destination.channel,
      to: destination.to,
      ...(decision.reason ? { reason: decision.reason } : {}),
      sendPayload,
    };
  }
  if (decision.decision === "reroute") {
    const actionParams: Record<string, unknown> = {
      ...params.actionParams,
      channel: decision.destination.channel,
      to: decision.destination.to,
      target: decision.destination.to,
    };
    if (decision.destination.accountId) {
      actionParams.accountId = decision.destination.accountId;
    } else {
      delete actionParams.accountId;
    }
    if (decision.destination.threadId !== undefined) {
      actionParams.threadId = decision.destination.threadId;
    } else {
      delete actionParams.threadId;
    }
    delete actionParams.replyTo;
    delete actionParams.replyToId;
    applySendPayloadPartsToActionParams(actionParams, sendPayload);
    return { status: "reroute", params: actionParams, sendPayload };
  }
  return { status: "allow", sendPayload };
}
