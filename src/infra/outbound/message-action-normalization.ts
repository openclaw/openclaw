import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  ChannelMessageActionName,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.public.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import { applyTargetToParams } from "./channel-target.js";
import {
  actionHasTarget,
  actionRequiresTarget,
  MESSAGE_ACTION_TARGET_MODE,
} from "./message-action-spec.js";

function hasExplicitTargetPrefix(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

function normalizeLegacyChannelIdTarget(params: {
  action: ChannelMessageActionName;
  channel: string;
  channelId: string;
}): string {
  if (MESSAGE_ACTION_TARGET_MODE[params.action] !== "to") {
    return params.channelId;
  }
  if (hasExplicitTargetPrefix(params.channelId)) {
    return params.channelId;
  }
  if (params.channel !== "discord") {
    return params.channelId;
  }
  return `channel:${params.channelId}`;
}

export function normalizeMessageActionInput(params: {
  action: ChannelMessageActionName;
  args: Record<string, unknown>;
  toolContext?: ChannelThreadingToolContext;
}): Record<string, unknown> {
  const normalizedArgs = { ...params.args };
  const { action, toolContext } = params;
  const explicitChannel = normalizeOptionalString(normalizedArgs.channel) ?? "";
  const inferredChannel =
    explicitChannel || normalizeMessageChannel(toolContext?.currentChannelProvider) || "";

  const explicitTarget = normalizeOptionalString(normalizedArgs.target) ?? "";
  const hasLegacyTargetFields =
    typeof normalizedArgs.to === "string" || typeof normalizedArgs.channelId === "string";
  const hasLegacyTarget =
    (normalizeOptionalString(normalizedArgs.to) ?? "").length > 0 ||
    (normalizeOptionalString(normalizedArgs.channelId) ?? "").length > 0;

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
    const inferredTarget = normalizeOptionalString(toolContext?.currentChannelId);
    if (inferredTarget) {
      normalizedArgs.target = inferredTarget;
    }
  }

  if (!explicitTarget && actionRequiresTarget(action) && hasLegacyTarget) {
    const legacyTo = normalizeOptionalString(normalizedArgs.to) ?? "";
    const legacyChannelId = normalizeOptionalString(normalizedArgs.channelId) ?? "";
    if (legacyTo) {
      normalizedArgs.target = legacyTo;
      delete normalizedArgs.to;
      delete normalizedArgs.channelId;
    } else if (legacyChannelId) {
      normalizedArgs.target = normalizeLegacyChannelIdTarget({
        action,
        channel: inferredChannel,
        channelId: legacyChannelId,
      });
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
