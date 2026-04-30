import type { ReplyPayload } from "../../auto-reply/types.js";
import type { PolicyRequest } from "../../security/action-sink-policy.js";
import { containsCompletionClaim } from "../../security/completion-claim-policy.js";
import type { DeliverOutboundPayloadsParams } from "./deliver.js";

function textFromPayload(payload: ReplyPayload): string {
  const parts: string[] = [];
  const record = payload as ReplyPayload & { message?: unknown; caption?: unknown };
  if (typeof record.text === "string") {
    parts.push(record.text);
  }
  if (typeof record.message === "string") {
    parts.push(record.message);
  }
  if (typeof record.caption === "string") {
    parts.push(record.caption);
  }
  return parts.join("\n");
}

export function buildOutboundDeliveryPolicyRequest(
  params: DeliverOutboundPayloadsParams,
): PolicyRequest {
  const text = params.payloads.map(textFromPayload).filter(Boolean).join("\n");
  return {
    policyVersion: "v1",
    actionType: containsCompletionClaim(text) ? "completion_claim" : "message_send",
    toolName: "outbound.deliver",
    targetResource: `${params.channel}:${params.to}`,
    payloadSummary: {
      channel: params.channel,
      to: params.to,
      accountId: params.accountId,
      payloadCount: params.payloads.length,
      text,
      hasMedia: params.payloads.some(
        (payload) => Boolean(payload.mediaUrl) || Boolean(payload.mediaUrls?.length),
      ),
      skipQueue: params.skipQueue === true,
    },
    actor: {
      id: params.session?.agentId ?? params.mirror?.agentId,
      sessionKey: params.session?.key ?? params.session?.policyKey ?? params.mirror?.sessionKey,
    },
    context: {
      channel: params.channel,
      to: params.to,
      accountId: params.accountId,
      sessionKey: params.session?.key,
      policySessionKey: params.session?.policyKey,
      threadId: params.threadId,
      replyToId: params.replyToId,
    },
  };
}

export function buildMessageActionPolicyRequest(params: {
  channel: string;
  action: string;
  to?: string;
  accountId?: string | null;
  args: Record<string, unknown>;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  requesterSenderId?: string | null;
}): PolicyRequest {
  const text =
    (typeof params.args.message === "string" ? params.args.message : undefined) ??
    (typeof params.args.caption === "string" ? params.args.caption : "");
  return {
    policyVersion: "v1",
    actionType: containsCompletionClaim(text) ? "completion_claim" : "message_send",
    toolName: `message.${params.action}`,
    targetResource: params.to ? `${params.channel}:${params.to}` : params.channel,
    payloadSummary: {
      channel: params.channel,
      action: params.action,
      to: params.to,
      accountId: params.accountId,
      args: params.args,
      text,
    },
    actor: {
      id: params.agentId,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
    },
    context: {
      channel: params.channel,
      action: params.action,
      to: params.to,
      accountId: params.accountId,
      requesterSenderId: params.requesterSenderId,
    },
  };
}
