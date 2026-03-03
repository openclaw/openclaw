import type {
  ChannelMessageActionName,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import { applyTargetToParams } from "./channel-target.js";
import { actionHasTarget, actionRequiresTarget } from "./message-action-spec.js";

export function normalizeMessageActionInput(params: {
  action: ChannelMessageActionName;
  args: Record<string, unknown>;
  toolContext?: ChannelThreadingToolContext;
}): Record<string, unknown> {
  const normalizedArgs = { ...params.args };
  const { action, toolContext } = params;

  const explicitTarget =
    typeof normalizedArgs.target === "string" ? normalizedArgs.target.trim() : "";
  const hasLegacyTarget =
    (typeof normalizedArgs.to === "string" && normalizedArgs.to.trim().length > 0) ||
    (typeof normalizedArgs.channelId === "string" && normalizedArgs.channelId.trim().length > 0);

  if (explicitTarget && hasLegacyTarget) {
    delete normalizedArgs.to;
    delete normalizedArgs.channelId;
  }

  if (
    !explicitTarget &&
    !hasLegacyTarget &&
    actionRequiresTarget(action) &&
    !actionHasTarget(action, normalizedArgs)
  ) {
    const inferredTarget = toolContext?.currentChannelId?.trim();
    if (inferredTarget) {
      normalizedArgs.target = inferredTarget;
    }
  }

  if (!explicitTarget && actionRequiresTarget(action) && hasLegacyTarget) {
    const legacyTo = typeof normalizedArgs.to === "string" ? normalizedArgs.to.trim() : "";
    const legacyChannelId =
      typeof normalizedArgs.channelId === "string" ? normalizedArgs.channelId.trim() : "";
    const legacyTarget = legacyTo || legacyChannelId;
    if (legacyTarget) {
      normalizedArgs.target = legacyTarget;
      delete normalizedArgs.to;
      delete normalizedArgs.channelId;
    }
  }

  const explicitChannel =
    typeof normalizedArgs.channel === "string" ? normalizedArgs.channel.trim() : "";
  if (!explicitChannel) {
    const inferredChannel = normalizeMessageChannel(toolContext?.currentChannelProvider);
    if (inferredChannel && isDeliverableMessageChannel(inferredChannel)) {
      normalizedArgs.channel = inferredChannel;
    }
  }

  if ((action === "react" || action === "reactions") && !normalizedArgs.messageId) {
    const inferredMessageId =
      toolContext?.currentMessageTs?.trim() ??
      (toolContext?.currentMessageId != null ? String(toolContext.currentMessageId).trim() : "");
    if (inferredMessageId) {
      normalizedArgs.messageId = inferredMessageId;
    }
  }

  applyTargetToParams({ action, args: normalizedArgs });
  if (actionRequiresTarget(action) && !actionHasTarget(action, normalizedArgs)) {
    throw new Error(`Action ${action} requires a target.`);
  }

  return normalizedArgs;
}
