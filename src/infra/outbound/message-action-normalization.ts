import type {
  ChannelMessageActionName,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.public.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
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

  // Card-aware text sanitization: when a card payload is present, the
  // `message`/`text` parameter is typically a notification preview or card
  // title rather than a standalone message body. Channel plugins that support
  // cards (Feishu, Teams, Slack, etc.) would otherwise send both a text
  // message and the card, resulting in duplicates. Move the text to a hint
  // field so plugins can use it for push-notification previews without
  // sending a visible text message.
  if (action === "send" && normalizedArgs.card != null && typeof normalizedArgs.card === "object") {
    const msgText = normalizeOptionalString(normalizedArgs.message as string) ?? "";
    const altText = normalizeOptionalString(normalizedArgs.text as string) ?? "";
    const hintText = msgText || altText;
    if (hintText) {
      normalizedArgs._cardNotificationHint = hintText;
    }
    if (msgText) delete normalizedArgs.message;
    if (altText) delete normalizedArgs.text;
  }

  return normalizedArgs;
}
