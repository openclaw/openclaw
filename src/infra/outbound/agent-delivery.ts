import type { ChannelOutboundTargetMode } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { normalizeAccountId } from "../../utils/account-id.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  isGatewayMessageChannel,
  normalizeMessageChannel,
  type GatewayMessageChannel,
} from "../../utils/message-channel.js";
import type { OutboundTargetResolution } from "./targets.js";
import {
  resolveOutboundTarget,
  resolveSessionDeliveryTarget,
  type SessionDeliveryTarget,
} from "./targets.js";

export type AgentDeliveryPlan = {
  baseDelivery: SessionDeliveryTarget;
  resolvedChannel: GatewayMessageChannel;
  resolvedTo?: string;
  resolvedAccountId?: string;
  resolvedThreadId?: string | number;
  deliveryTargetMode?: ChannelOutboundTargetMode;
};

export function resolveAgentDeliveryPlan(params: {
  sessionEntry?: SessionEntry;
  requestedChannel?: string;
  explicitTo?: string;
  explicitThreadId?: string | number;
  accountId?: string;
  wantsDelivery: boolean;
  /**
   * The channel that originated the current agent turn.  When provided,
   * overrides session-level `lastChannel` to prevent cross-channel reply
   * routing in shared sessions (dmScope="main").
   *
   * @see https://github.com/openclaw/openclaw/issues/24152
   */
  turnSourceChannel?: string;
  /** Turn-source `to` — paired with `turnSourceChannel`. */
  turnSourceTo?: string;
  /** Turn-source `accountId` — paired with `turnSourceChannel`. */
  turnSourceAccountId?: string;
  /** Turn-source `threadId` — paired with `turnSourceChannel`. */
  turnSourceThreadId?: string | number;
}): AgentDeliveryPlan {
  // Bug fix for #35300: Detect webchat heartbeat messages BEFORE channel normalization.
  // When heartbeat messages from webchat trigger agent responses, the incoming requestedChannel
  // may be "webchat", but downstream processing converts it to "last". At that point, detection
  // based on the normalized channel fails. We must intercept here at the entry point.
  //
  // Context: resolveAgentDeliveryPlan normalizes "webchat" → "last" because INTERNAL_MESSAGE_CHANNEL
  // is not deliverable. By the time we reach resolveSessionDeliveryTarget, the original "webchat"
  // signal is lost, and heartbeat detection no longer works.
  //
  // Solution: Check the raw requestedChannel/explicitTo BEFORE normalization, and if we detect
  // a heartbeat scenario, force turnSourceChannel to override any stale session deliveryContext.
  const rawRequestedChannel =
    typeof params.requestedChannel === "string" ? params.requestedChannel.trim() : "";
  const rawExplicitTo =
    typeof params.explicitTo === "string" ? params.explicitTo.trim() : undefined;
  const rawTurnSourceChannel =
    typeof params.turnSourceChannel === "string" ? params.turnSourceChannel.trim() : undefined;

  // Heartbeat detection: webchat + "heartbeat" target
  // P2 fix: Use case-insensitive comparison to catch "WebChat", "WEBCHAT", etc.
  const isWebchatHeartbeat =
    (rawRequestedChannel.toLowerCase() === "webchat" && rawExplicitTo === "heartbeat") ||
    (rawTurnSourceChannel?.toLowerCase() === "webchat" && rawExplicitTo === "heartbeat");

  const requestedRaw =
    typeof params.requestedChannel === "string" ? params.requestedChannel.trim() : "";
  const normalizedRequested = requestedRaw ? normalizeMessageChannel(requestedRaw) : undefined;
  const requestedChannel = normalizedRequested || "last";

  const explicitTo =
    typeof params.explicitTo === "string" && params.explicitTo.trim()
      ? params.explicitTo.trim()
      : undefined;

  // Resolve turn-source channel for cross-channel safety.
  const normalizedTurnSource = params.turnSourceChannel
    ? normalizeMessageChannel(params.turnSourceChannel)
    : undefined;
  const turnSourceChannel =
    normalizedTurnSource && isDeliverableMessageChannel(normalizedTurnSource)
      ? normalizedTurnSource
      : undefined;
  const turnSourceTo =
    typeof params.turnSourceTo === "string" && params.turnSourceTo.trim()
      ? params.turnSourceTo.trim()
      : undefined;
  const turnSourceAccountId = normalizeAccountId(params.turnSourceAccountId);
  const turnSourceThreadId =
    params.turnSourceThreadId != null && params.turnSourceThreadId !== ""
      ? params.turnSourceThreadId
      : undefined;

  // When webchat heartbeat is detected, DO NOT pass sessionEntry to resolveSessionDeliveryTarget.
  // This prevents the stale deliveryContext (which may have a different channel like "feishu") from
  // overriding the actual turnSourceChannel ("webchat"). By clearing the entry, we force the system
  // to rely solely on turnSourceChannel for routing, which is the correct behavior for heartbeat.
  const effectiveEntry = isWebchatHeartbeat ? undefined : params.sessionEntry;

  const baseDelivery = resolveSessionDeliveryTarget({
    entry: effectiveEntry,
    requestedChannel: requestedChannel === INTERNAL_MESSAGE_CHANNEL ? "last" : requestedChannel,
    explicitTo,
    explicitThreadId: params.explicitThreadId,
    turnSourceChannel,
    turnSourceTo,
    turnSourceAccountId,
    turnSourceThreadId,
  });

  const resolvedChannel = (() => {
    if (requestedChannel === INTERNAL_MESSAGE_CHANNEL) {
      return INTERNAL_MESSAGE_CHANNEL;
    }
    if (requestedChannel === "last") {
      if (baseDelivery.channel && baseDelivery.channel !== INTERNAL_MESSAGE_CHANNEL) {
        return baseDelivery.channel;
      }
      return INTERNAL_MESSAGE_CHANNEL;
    }

    if (isGatewayMessageChannel(requestedChannel)) {
      return requestedChannel;
    }

    if (baseDelivery.channel && baseDelivery.channel !== INTERNAL_MESSAGE_CHANNEL) {
      return baseDelivery.channel;
    }
    return INTERNAL_MESSAGE_CHANNEL;
  })();

  const deliveryTargetMode = explicitTo
    ? "explicit"
    : isDeliverableMessageChannel(resolvedChannel)
      ? "implicit"
      : undefined;

  const resolvedAccountId =
    normalizeAccountId(params.accountId) ??
    (deliveryTargetMode === "implicit" ? baseDelivery.accountId : undefined);

  let resolvedTo = explicitTo;
  if (
    !resolvedTo &&
    isDeliverableMessageChannel(resolvedChannel) &&
    resolvedChannel === baseDelivery.lastChannel
  ) {
    resolvedTo = baseDelivery.lastTo;
  }

  return {
    baseDelivery,
    resolvedChannel,
    resolvedTo,
    resolvedAccountId,
    resolvedThreadId: baseDelivery.threadId,
    deliveryTargetMode,
  };
}

export function resolveAgentOutboundTarget(params: {
  cfg: OpenClawConfig;
  plan: AgentDeliveryPlan;
  targetMode?: ChannelOutboundTargetMode;
  validateExplicitTarget?: boolean;
}): {
  resolvedTarget: OutboundTargetResolution | null;
  resolvedTo?: string;
  targetMode: ChannelOutboundTargetMode;
} {
  const targetMode =
    params.targetMode ??
    params.plan.deliveryTargetMode ??
    (params.plan.resolvedTo ? "explicit" : "implicit");
  if (!isDeliverableMessageChannel(params.plan.resolvedChannel)) {
    return {
      resolvedTarget: null,
      resolvedTo: params.plan.resolvedTo,
      targetMode,
    };
  }
  if (params.validateExplicitTarget !== true && params.plan.resolvedTo) {
    return {
      resolvedTarget: null,
      resolvedTo: params.plan.resolvedTo,
      targetMode,
    };
  }
  const resolvedTarget = resolveOutboundTarget({
    channel: params.plan.resolvedChannel,
    to: params.plan.resolvedTo,
    cfg: params.cfg,
    accountId: params.plan.resolvedAccountId,
    mode: targetMode,
  });
  return {
    resolvedTarget,
    resolvedTo: resolvedTarget.ok ? resolvedTarget.to : params.plan.resolvedTo,
    targetMode,
  };
}
