import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isMessageToolSendActionName } from "../../agents/embedded-agent-messaging.js";
import type {
  ChannelMessageActionName,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.public.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import {
  isDeliverableMessageChannel,
  isInternalNonDeliveryChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import {
  actionHasResourceReference,
  actionHasTarget,
  actionRequiresTarget,
  applyTargetToParams,
  resolveActionDeliveryTargetAlias,
  type ActionDeliveryTargetAliasSpec,
} from "./message-action-spec.js";
import { missingMessageActionTargetError } from "./target-errors.js";

export function resolveImplicitMessageActionTarget(
  toolContext: ChannelThreadingToolContext | undefined,
  action?: ChannelMessageActionName,
): string | undefined {
  // Content replies follow the effective delivery route; message resources still
  // belong to the native conversation that supplied the inbound message.
  const candidates =
    isMessageToolSendActionName(action) || action === "poll"
      ? [toolContext?.currentMessagingTarget, toolContext?.currentChannelId]
      : [toolContext?.currentChannelId, toolContext?.currentMessagingTarget];
  for (const value of candidates) {
    const target = normalizeOptionalString(value);
    if (!target || isInternalNonDeliveryChannel(target)) {
      continue;
    }
    // A session can arrive bare or wrapped as a channel target; neither is
    // a transport destination. Keep searching for the real conversation.
    if (parseAgentSessionKey(target.replace(/^channel:/i, ""))) {
      continue;
    }
    return target;
  }
  return undefined;
}

export function normalizeMessageActionInput(params: {
  action: ChannelMessageActionName;
  args: Record<string, unknown>;
  toolContext?: ChannelThreadingToolContext;
  targetAliasSpec?: ActionDeliveryTargetAliasSpec | null;
  allowResourceOnly?: boolean;
}): Record<string, unknown> {
  const normalizedArgs = { ...params.args };
  const { action, toolContext } = params;
  const explicitChannel = normalizeOptionalString(normalizedArgs.channel) ?? "";
  const inferredChannel =
    explicitChannel || normalizeMessageChannel(toolContext?.currentChannelProvider) || "";

  const explicitTarget = normalizeOptionalString(normalizedArgs.target) ?? "";
  const hasExplicitTargets = Object.hasOwn(normalizedArgs, "targets");
  const hasLegacyTargetFields =
    typeof normalizedArgs.to === "string" || typeof normalizedArgs.channelId === "string";
  const legacyTarget =
    normalizeOptionalString(normalizedArgs.to) ??
    normalizeOptionalString(normalizedArgs.channelId) ??
    "";
  const targetAliasOptions = {
    channel: inferredChannel,
    aliasSpec: params.targetAliasSpec,
  };
  const deliveryAliasTarget = resolveActionDeliveryTargetAlias(
    action,
    normalizedArgs,
    targetAliasOptions,
  );
  const hasResourceReference = actionHasResourceReference(
    action,
    normalizedArgs,
    targetAliasOptions,
  );

  if (
    deliveryAliasTarget &&
    ((explicitTarget && deliveryAliasTarget !== explicitTarget) ||
      (legacyTarget && deliveryAliasTarget !== legacyTarget))
  ) {
    throw new Error(`Action ${action} received conflicting target and delivery alias values.`);
  }

  if (explicitTarget && hasLegacyTargetFields) {
    // Canonical `target` wins over old `to`/`channelId` aliases before validation.
    delete normalizedArgs.to;
    delete normalizedArgs.channelId;
  }

  if (!explicitTarget && !legacyTarget && deliveryAliasTarget) {
    normalizedArgs.target = deliveryAliasTarget;
  }

  if (!explicitTarget && actionRequiresTarget(action)) {
    if (legacyTarget) {
      normalizedArgs.target = legacyTarget;
      delete normalizedArgs.to;
      delete normalizedArgs.channelId;
    } else if (
      !hasExplicitTargets &&
      !deliveryAliasTarget &&
      (hasResourceReference || !actionHasTarget(action, normalizedArgs, targetAliasOptions))
    ) {
      const inferredTarget = resolveImplicitMessageActionTarget(toolContext, action);
      if (inferredTarget) {
        normalizedArgs.target = inferredTarget;
      }
    }
  }

  if (!explicitChannel && inferredChannel && isDeliverableMessageChannel(inferredChannel)) {
    normalizedArgs.channel = inferredChannel;
  }

  applyTargetToParams({ action, args: normalizedArgs });
  const hasCanonicalTarget = [
    normalizedArgs.target,
    normalizedArgs.to,
    normalizedArgs.channelId,
  ].some((value) => Boolean(normalizeOptionalString(value)));
  if (
    actionRequiresTarget(action) &&
    (!actionHasTarget(action, normalizedArgs, targetAliasOptions) ||
      (hasResourceReference && !hasCanonicalTarget && !params.allowResourceOnly))
  ) {
    throw missingMessageActionTargetError(action);
  }

  return normalizedArgs;
}
