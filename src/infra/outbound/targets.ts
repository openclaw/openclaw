import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import type { ChannelId, ChannelOutboundTargetMode } from "../../channels/plugins/types.js";
import type { ClawdbotConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.js";
import type {
  DeliverableMessageChannel,
  GatewayMessageChannel,
} from "../../utils/message-channel.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";

export type OutboundChannel = DeliverableMessageChannel | "none";

export type HeartbeatTarget = OutboundChannel | "last";

export type OutboundTarget = {
  channel: OutboundChannel;
  to?: string;
  reason?: string;
  accountId?: string;
  lastChannel?: DeliverableMessageChannel;
  lastAccountId?: string;
};

export type OutboundTargetResolution = { ok: true; to: string } | { ok: false; error: Error };

export type SessionDeliveryTarget = {
  channel?: DeliverableMessageChannel;
  to?: string;
  accountId?: string;
  mode: ChannelOutboundTargetMode;
  lastChannel?: DeliverableMessageChannel;
  lastTo?: string;
  lastAccountId?: string;
};

export function resolveSessionDeliveryTarget(params: {
  entry?: SessionEntry;
  requestedChannel?: GatewayMessageChannel | "last";
  explicitTo?: string;
  fallbackChannel?: DeliverableMessageChannel;
  allowMismatchedLastTo?: boolean;
  mode?: ChannelOutboundTargetMode;
}): SessionDeliveryTarget {
  const context = deliveryContextFromSession(params.entry);
  const lastChannel =
    context?.channel && isDeliverableMessageChannel(context.channel) ? context.channel : undefined;
  const lastTo = context?.to;
  const lastAccountId = context?.accountId;

  const rawRequested = params.requestedChannel ?? "last";
  const requested = rawRequested === "last" ? "last" : normalizeMessageChannel(rawRequested);
  const requestedChannel =
    requested === "last"
      ? "last"
      : requested && isDeliverableMessageChannel(requested)
        ? requested
        : undefined;

  const explicitTo =
    typeof params.explicitTo === "string" && params.explicitTo.trim()
      ? params.explicitTo.trim()
      : undefined;

  let channel = requestedChannel === "last" ? lastChannel : requestedChannel;
  if (!channel && params.fallbackChannel && isDeliverableMessageChannel(params.fallbackChannel)) {
    channel = params.fallbackChannel;
  }

  let to = explicitTo;
  if (!to && lastTo) {
    if (channel && channel === lastChannel) {
      to = lastTo;
    } else if (params.allowMismatchedLastTo) {
      to = lastTo;
    }
  }

  const accountId = channel && channel === lastChannel ? lastAccountId : undefined;
  const mode = params.mode ?? (explicitTo ? "explicit" : "implicit");

  return {
    channel,
    to,
    accountId,
    mode,
    lastChannel,
    lastTo,
    lastAccountId,
  };
}

// Channel docking: prefer plugin.outbound.resolveTarget + allowFrom to normalize destinations.
export function resolveOutboundTarget(params: {
  channel: GatewayMessageChannel;
  to?: string;
  allowFrom?: string[];
  cfg?: ClawdbotConfig;
  accountId?: string | null;
  mode?: ChannelOutboundTargetMode;
}): OutboundTargetResolution {
  if (params.channel === INTERNAL_MESSAGE_CHANNEL) {
    return {
      ok: false,
      error: new Error(
        "Delivering to WebChat is not supported via `clawdbot agent`; use WhatsApp/Telegram or run with --deliver=false.",
      ),
    };
  }

  const plugin = getChannelPlugin(params.channel as ChannelId);
  if (!plugin) {
    return {
      ok: false,
      error: new Error(`Unsupported channel: ${params.channel}`),
    };
  }

  const allowFrom =
    params.allowFrom ??
    (params.cfg && plugin.config.resolveAllowFrom
      ? plugin.config.resolveAllowFrom({
          cfg: params.cfg,
          accountId: params.accountId ?? undefined,
        })
      : undefined);

  const resolveTarget = plugin.outbound?.resolveTarget;
  if (resolveTarget) {
    return resolveTarget({
      cfg: params.cfg,
      to: params.to,
      allowFrom,
      accountId: params.accountId ?? undefined,
      mode: params.mode ?? "explicit",
    });
  }

  const trimmed = params.to?.trim();
  if (trimmed) {
    return { ok: true, to: trimmed };
  }
  return {
    ok: false,
    error: new Error(`Delivering to ${plugin.meta.label} requires a destination`),
  };
}

export function resolveHeartbeatDeliveryTarget(params: {
  cfg: ClawdbotConfig;
  entry?: SessionEntry;
  heartbeat?: AgentDefaultsConfig["heartbeat"];
}): OutboundTarget {
  const { cfg, entry } = params;
  const heartbeat = params.heartbeat ?? cfg.agents?.defaults?.heartbeat;
  const rawTarget = heartbeat?.target;
  let target: HeartbeatTarget = "last";
  if (rawTarget === "none" || rawTarget === "last") {
    target = rawTarget;
  } else if (typeof rawTarget === "string") {
    const normalized = normalizeChannelId(rawTarget);
    if (normalized) target = normalized;
  }

  if (target === "none") {
    const base = resolveSessionDeliveryTarget({ entry });
    return {
      channel: "none",
      reason: "target-none",
      accountId: undefined,
      lastChannel: base.lastChannel,
      lastAccountId: base.lastAccountId,
    };
  }

  const resolvedTarget = resolveSessionDeliveryTarget({
    entry,
    requestedChannel: target === "last" ? "last" : target,
    explicitTo: heartbeat?.to,
    mode: "heartbeat",
  });

  if (!resolvedTarget.channel || !resolvedTarget.to) {
    return {
      channel: "none",
      reason: "no-target",
      accountId: resolvedTarget.accountId,
      lastChannel: resolvedTarget.lastChannel,
      lastAccountId: resolvedTarget.lastAccountId,
    };
  }

  const resolved = resolveOutboundTarget({
    channel: resolvedTarget.channel,
    to: resolvedTarget.to,
    cfg,
    accountId: resolvedTarget.accountId,
    mode: "heartbeat",
  });
  if (!resolved.ok) {
    return {
      channel: "none",
      reason: "no-target",
      accountId: resolvedTarget.accountId,
      lastChannel: resolvedTarget.lastChannel,
      lastAccountId: resolvedTarget.lastAccountId,
    };
  }

  let reason: string | undefined;
  const plugin = getChannelPlugin(resolvedTarget.channel as ChannelId);
  if (plugin?.config.resolveAllowFrom) {
    const explicit = resolveOutboundTarget({
      channel: resolvedTarget.channel,
      to: resolvedTarget.to,
      cfg,
      accountId: resolvedTarget.accountId,
      mode: "explicit",
    });
    if (explicit.ok && explicit.to !== resolved.to) {
      reason = "allowFrom-fallback";
    }
  }

  return {
    channel: resolvedTarget.channel,
    to: resolved.to,
    reason,
    accountId: resolvedTarget.accountId,
    lastChannel: resolvedTarget.lastChannel,
    lastAccountId: resolvedTarget.lastAccountId,
  };
}
