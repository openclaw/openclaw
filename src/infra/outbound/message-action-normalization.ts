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

function normalizeCurrentTargetComparable(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/^channel:/i, "");
}

export function normalizeMessageActionInput(params: {
  action: ChannelMessageActionName;
  args: Record<string, unknown>;
  toolContext?: ChannelThreadingToolContext;
}): Record<string, unknown> {
  const normalizedArgs = { ...params.args };
  const { action, toolContext } = params;
  const explicitChannel =
    typeof normalizedArgs.channel === "string" ? normalizedArgs.channel.trim() : "";
  const inferredChannel =
    explicitChannel || normalizeMessageChannel(toolContext?.currentChannelProvider) || "";

  const explicitTarget =
    typeof normalizedArgs.target === "string" ? normalizedArgs.target.trim() : "";
  const hasLegacyTargetFields =
    typeof normalizedArgs.to === "string" || typeof normalizedArgs.channelId === "string";
  const hasLegacyTarget =
    (typeof normalizedArgs.to === "string" && normalizedArgs.to.trim().length > 0) ||
    (typeof normalizedArgs.channelId === "string" && normalizedArgs.channelId.trim().length > 0);

  if (explicitTarget && hasLegacyTargetFields) {
    delete normalizedArgs.to;
    delete normalizedArgs.channelId;
  }

  if (
    !explicitTarget &&
    !hasLegacyTarget &&
    actionRequiresTarget(action) &&
    !actionHasTarget(action, normalizedArgs, { channel: inferredChannel })
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

  if (!explicitChannel) {
    if (inferredChannel && isDeliverableMessageChannel(inferredChannel)) {
      normalizedArgs.channel = inferredChannel;
    }
  }

  if ((action === "react" || action === "reactions") && !normalizedArgs.messageId) {
    const inferredMessageId = toolContext?.currentMessageTs?.trim();
    const comparableArgs = { ...normalizedArgs };
    applyTargetToParams({ action, args: comparableArgs });
    const normalizedTarget = normalizeCurrentTargetComparable(comparableArgs.target);
    const normalizedCurrentTarget = normalizeCurrentTargetComparable(toolContext?.currentChannelId);
    const hasAnyExplicitTarget = actionHasTarget(action, comparableArgs, {
      channel: inferredChannel,
    });
    const sameTargetAsContext =
      !!normalizedTarget &&
      !!normalizedCurrentTarget &&
      normalizedTarget === normalizedCurrentTarget;
    const shouldInferMessageId = !hasAnyExplicitTarget || sameTargetAsContext;
    if (inferredMessageId && shouldInferMessageId) {
      normalizedArgs.messageId = inferredMessageId;
    }
  }

  applyTargetToParams({ action, args: normalizedArgs });
  if (
    actionRequiresTarget(action) &&
    !actionHasTarget(action, normalizedArgs, { channel: inferredChannel })
  ) {
    throw new Error(`Action ${action} requires a target.`);
  }

  return normalizedArgs;
}
