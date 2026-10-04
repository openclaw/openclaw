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

  if (params.action === "send" || params.action === "poll") {
    return {
      ...(params.action === "send"
        ? { kind: "send" as const, channel, action: "send" as const }
        : { kind: "poll" as const, channel, action: "poll" as const }),
      to: target,
      handledBy: "plugin",
      payload: partialDelivery,
      dryRun: false,
    };
  }
  return {
    kind: "action",
    channel,
    action: params.action,
    handledBy: "plugin",
    payload: partialDelivery,
    dryRun: false,
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
