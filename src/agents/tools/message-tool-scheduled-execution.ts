import type { ChannelMessageActionName } from "../../channels/plugins/types.public.js";
import type { MessageActionResult } from "../../infra/outbound/message-action-contracts.js";
import { projectMessageActionPartialDelivery } from "../../infra/outbound/message-action-execution.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import { readToolStringParam } from "./common.js";

export function projectScheduledMessageActionPartialResult(params: {
  error: unknown;
  action: ChannelMessageActionName;
  actionParams: Record<string, unknown>;
  scopeChannel?: unknown;
  hasScheduledAuthority: boolean;
}): MessageActionResult | undefined {
  if (!params.hasScheduledAuthority || params.action === "broadcast") {
    return undefined;
  }
  const partialDelivery = projectMessageActionPartialDelivery(params.error);
  if (!partialDelivery) {
    return undefined;
  }
  const channel =
    normalizeMessageChannel(
      typeof params.actionParams.channel === "string" ? params.actionParams.channel : undefined,
    ) ??
    normalizeMessageChannel(
      typeof params.scopeChannel === "string" ? params.scopeChannel : undefined,
    ) ??
    "unknown";
  const target =
    readToolStringParam(params.actionParams, "to") ??
    readToolStringParam(params.actionParams, "target") ??
    "unknown";

  return {
    ...(params.action === "send"
      ? { kind: "send" as const, channel, action: "send" as const, to: target }
      : params.action === "poll"
        ? { kind: "poll" as const, channel, action: "poll" as const, to: target }
        : { kind: "action" as const, channel, action: params.action }),
    handledBy: "plugin",
    payload: partialDelivery,
    dryRun: false,
  };
}

/**
 * Failure projection for callers without scheduled authority. The operation stays a
 * failure, but the accepted message ids must survive it: native and MCP error responses
 * read this tool result, and a caller that only sees the error text cannot tell a partial
 * delivery from a total one and may resend what already landed.
 */
export function projectMessageActionPartialFailureResult(params: {
  error: unknown;
  action: ChannelMessageActionName;
}): Record<string, unknown> | undefined {
  const partialDelivery = projectMessageActionPartialDelivery(params.error);
  if (!partialDelivery) {
    return undefined;
  }
  const messageIds = Array.isArray(partialDelivery.result.messageIds)
    ? partialDelivery.result.messageIds.filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      )
    : [];
  return {
    ok: false,
    action: params.action,
    deliveryStatus: "partial_failed",
    sentBeforeError: true,
    error: partialDelivery.error,
    acceptedMessageIds: messageIds,
    remainderUnconfirmed: true,
    message: messageIds.length
      ? `Delivered ${messageIds.length} message(s) before the send failed; the remaining content is unconfirmed. Do not resend the accepted message(s).`
      : "The provider accepted some content before the send failed; the remaining content is unconfirmed. Do not resend accepted content.",
  };
}

export function shouldRevalidateCompletedMessageAction(params: {
  hasScheduledAuthority: boolean;
  scheduledRead: boolean;
  dryRun: boolean;
  acceptedResult: boolean;
}): boolean {
  return (
    !params.hasScheduledAuthority || params.scheduledRead || params.dryRun || !params.acceptedResult
  );
}
