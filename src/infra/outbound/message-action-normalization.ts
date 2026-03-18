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

const TARGET_INFERRED_FROM_TOOL_CONTEXT = "__targetInferredFromToolContext";

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
      normalizedArgs[TARGET_INFERRED_FROM_TOOL_CONTEXT] = true;
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

  applyTargetToParams({ action, args: normalizedArgs });
  if (
    actionRequiresTarget(action) &&
    !actionHasTarget(action, normalizedArgs, { channel: inferredChannel })
  ) {
    throw new Error(`Action ${action} requires a target.`);
  }

  return normalizedArgs;
}

export function consumeTargetInferredFromToolContext(
  args: Record<string, unknown>,
): boolean {
  const inferred = args[TARGET_INFERRED_FROM_TOOL_CONTEXT] === true;
  delete args[TARGET_INFERRED_FROM_TOOL_CONTEXT];
  return inferred;
}
