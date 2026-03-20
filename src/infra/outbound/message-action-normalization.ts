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

  // LLMs (especially in cron/isolated contexts without toolContext) sometimes place the
  // target identifier in "channel" instead of "target" — e.g. "channel:123456" when the
  // intended field is "target". Recover by promoting "channel" to "target" when: (a) no
  // explicit target was resolved yet, (b) the channel value looks like a target identifier
  // (contains ":" — e.g. "channel:id", "user:id", "+phone"), and (c) the action needs one.
  if (
    actionRequiresTarget(action) &&
    !actionHasTarget(action, normalizedArgs) &&
    explicitChannel &&
    explicitChannel.includes(":")
  ) {
    normalizedArgs.target = explicitChannel;
    // The channel field contained a target identifier, not a valid provider name.
    // Clear it so downstream code does not treat a target like "channel:123" as
    // a messaging provider.
    delete normalizedArgs.channel;
  }

  applyTargetToParams({ action, args: normalizedArgs });
  if (actionRequiresTarget(action) && !actionHasTarget(action, normalizedArgs)) {
    throw new Error(`Action ${action} requires a target.`);
  }

  return normalizedArgs;
}
