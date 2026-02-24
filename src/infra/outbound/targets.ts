import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import type { ChannelOutboundTargetMode } from "../../channels/plugins/types.js";
import { formatCliCommand } from "../../cli/command-format.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import { parseTelegramTarget } from "../../telegram/targets.js";
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
import { missingTargetError } from "./target-errors.js";

export type OutboundChannel = DeliverableMessageChannel | "none";

export type HeartbeatTarget = OutboundChannel | "last";

export type OutboundTarget = {
  channel: OutboundChannel;
  to?: string;
  reason?: string;
  accountId?: string;
  threadId?: string | number;
  lastChannel?: DeliverableMessageChannel;
  lastAccountId?: string;
};

export type HeartbeatSenderContext = {
  sender: string;
  provider?: DeliverableMessageChannel;
  allowFrom: string[];
};

export type OutboundTargetResolution = { ok: true; to: string } | { ok: false; error: Error };

export type SessionDeliveryTarget = {
  channel?: DeliverableMessageChannel;
  to?: string;
  accountId?: string;
  threadId?: string | number;
  /** Whether threadId came from an explicit source (config/param/:topic: parsing) vs session history. */
  threadIdExplicit?: boolean;
  mode: ChannelOutboundTargetMode;
  lastChannel?: DeliverableMessageChannel;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
};

export function resolveSessionDeliveryTarget(params: {
  entry?: SessionEntry;
  requestedChannel?: GatewayMessageChannel | "last";
  explicitTo?: string;
  explicitThreadId?: string | number;
  fallbackChannel?: DeliverableMessageChannel;
  allowMismatchedLastTo?: boolean;
  mode?: ChannelOutboundTargetMode;
}): SessionDeliveryTarget {
  const context = deliveryContextFromSession(params.entry);
  const lastChannel =
    context?.channel && isDeliverableMessageChannel(context.channel) ? context.channel : undefined;
  const lastTo = context?.to;
  const lastAccountId = context?.accountId;
  const lastThreadId = context?.threadId;

  const rawRequested = params.requestedChannel ?? "last";
  const requested = rawRequested === "last" ? "last" : normalizeMessageChannel(rawRequested);
  const requestedChannel =
    requested === "last"
      ? "last"
      : requested && isDeliverableMessageChannel(requested)
        ? requested
        : undefined;

  const rawExplicitTo =
    typeof params.explicitTo === "string" && params.explicitTo.trim()
      ? params.explicitTo.trim()
      : undefined;

  let channel = requestedChannel === "last" ? lastChannel : requestedChannel;
  if (!channel && params.fallbackChannel && isDeliverableMessageChannel(params.fallbackChannel)) {
    channel = params.fallbackChannel;
  }

  // Parse :topic:NNN from explicitTo (Telegram topic syntax).
  // Only applies when we positively know the channel is Telegram.
  // When channel is unknown, the downstream send path (resolveTelegramSession)
  // handles :topic: parsing independently.
  const isTelegramContext = channel === "telegram" || (!channel && lastChannel === "telegram");
  let explicitTo = rawExplicitTo;
  let parsedThreadId: number | undefined;
  if (isTelegramContext && rawExplicitTo && rawExplicitTo.includes(":topic:")) {
    const parsed = parseTelegramTarget(rawExplicitTo);
    explicitTo = parsed.chatId;
    parsedThreadId = parsed.messageThreadId;
  }
  const explicitThreadId =
    params.explicitThreadId != null && params.explicitThreadId !== ""
      ? params.explicitThreadId
      : parsedThreadId;

  let to = explicitTo;
  if (!to && lastTo) {
    if (channel && channel === lastChannel) {
      to = lastTo;
    } else if (params.allowMismatchedLastTo) {
      to = lastTo;
    }
  }

  const mode = params.mode ?? (explicitTo ? "explicit" : "implicit");
  const accountId = channel && channel === lastChannel ? lastAccountId : undefined;
  const threadId =
    mode !== "heartbeat" && channel && channel === lastChannel ? lastThreadId : undefined;

  const resolvedThreadId = explicitThreadId ?? threadId;
  return {
    channel,
    to,
    accountId,
    threadId: resolvedThreadId,
    threadIdExplicit: resolvedThreadId != null && explicitThreadId != null,
    mode,
    lastChannel,
    lastTo,
    lastAccountId,
    lastThreadId,
  };
}

// Channel docking: prefer plugin.outbound.resolveTarget + allowFrom to normalize destinations.
export function resolveOutboundTarget(params: {
  channel: GatewayMessageChannel;
  to?: string;
  allowFrom?: string[];
  cfg?: OpenClawConfig;
  accountId?: string | null;
  mode?: ChannelOutboundTargetMode;
}): OutboundTargetResolution {
  if (params.channel === INTERNAL_MESSAGE_CHANNEL) {
    return {
      ok: false,
      error: new Error(
        `Delivering to WebChat is not supported via \`${formatCliCommand("openclaw agent")}\`; use WhatsApp/Telegram or run with --deliver=false.`,
      ),
    };
  }

  const plugin = getChannelPlugin(params.channel);
  if (!plugin) {
    return {
      ok: false,
      error: new Error(`Unsupported channel: ${params.channel}`),
    };
  }

  const allowFromRaw =
    params.allowFrom ??
    (params.cfg && plugin.config.resolveAllowFrom
      ? plugin.config.resolveAllowFrom({
          cfg: params.cfg,
          accountId: params.accountId ?? undefined,
        })
      : undefined);
  const allowFrom = allowFromRaw?.map((entry) => String(entry));

  // Fall back to per-channel defaultTo when no explicit target is provided.
  const effectiveTo =
    params.to?.trim() ||
    (params.cfg && plugin.config.resolveDefaultTo
      ? plugin.config.resolveDefaultTo({
          cfg: params.cfg,
          accountId: params.accountId ?? undefined,
        })
      : undefined);

  const resolveTarget = plugin.outbound?.resolveTarget;
  if (resolveTarget) {
    return resolveTarget({
      cfg: params.cfg,
      to: effectiveTo,
      allowFrom,
      accountId: params.accountId ?? undefined,
      mode: params.mode ?? "explicit",
    });
  }

  if (effectiveTo) {
    return { ok: true, to: effectiveTo };
  }
  const hint = plugin.messaging?.targetResolver?.hint;
  return {
    ok: false,
    error: missingTargetError(plugin.meta.label ?? params.channel, hint),
  };
}

export function resolveHeartbeatDeliveryTarget(params: {
  cfg: OpenClawConfig;
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
    if (normalized) {
      target = normalized;
    }
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

  const heartbeatAccountId = heartbeat?.accountId?.trim();
  // Use explicit accountId from heartbeat config if provided, otherwise fall back to session
  let effectiveAccountId = heartbeatAccountId || resolvedTarget.accountId;

  if (heartbeatAccountId && resolvedTarget.channel) {
    const plugin = getChannelPlugin(resolvedTarget.channel);
    const listAccountIds = plugin?.config.listAccountIds;
    const accountIds = listAccountIds ? listAccountIds(cfg) : [];
    if (accountIds.length > 0) {
      const normalizedAccountId = normalizeAccountId(heartbeatAccountId);
      const normalizedAccountIds = new Set(
        accountIds.map((accountId) => normalizeAccountId(accountId)),
      );
      if (!normalizedAccountIds.has(normalizedAccountId)) {
        return {
          channel: "none",
          reason: "unknown-account",
          accountId: normalizedAccountId,
          lastChannel: resolvedTarget.lastChannel,
          lastAccountId: resolvedTarget.lastAccountId,
        };
      }
      effectiveAccountId = normalizedAccountId;
    }
  }

  if (!resolvedTarget.channel || !resolvedTarget.to) {
    return {
      channel: "none",
      reason: "no-target",
      accountId: effectiveAccountId,
      lastChannel: resolvedTarget.lastChannel,
      lastAccountId: resolvedTarget.lastAccountId,
    };
  }

  const resolved = resolveOutboundTarget({
    channel: resolvedTarget.channel,
    to: resolvedTarget.to,
    cfg,
    accountId: effectiveAccountId,
    mode: "heartbeat",
  });
  if (!resolved.ok) {
    return {
      channel: "none",
      reason: "no-target",
      accountId: effectiveAccountId,
      lastChannel: resolvedTarget.lastChannel,
      lastAccountId: resolvedTarget.lastAccountId,
    };
  }

  let reason: string | undefined;
  const plugin = getChannelPlugin(resolvedTarget.channel);
  if (plugin?.config.resolveAllowFrom) {
    const explicit = resolveOutboundTarget({
      channel: resolvedTarget.channel,
      to: resolvedTarget.to,
      cfg,
      accountId: effectiveAccountId,
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
    accountId: effectiveAccountId,
    threadId: resolvedTarget.threadId,
    lastChannel: resolvedTarget.lastChannel,
    lastAccountId: resolvedTarget.lastAccountId,
  };
}

function resolveHeartbeatSenderId(params: {
  allowFrom: Array<string | number>;
  deliveryTo?: string;
  lastTo?: string;
  provider?: string | null;
}) {
  const { allowFrom, deliveryTo, lastTo, provider } = params;
  const candidates = [
    deliveryTo?.trim(),
    provider && deliveryTo ? `${provider}:${deliveryTo}` : undefined,
    lastTo?.trim(),
    provider && lastTo ? `${provider}:${lastTo}` : undefined,
  ].filter((val): val is string => Boolean(val?.trim()));

  const allowList = allowFrom
    .map((entry) => String(entry))
    .filter((entry) => entry && entry !== "*");
  if (allowFrom.includes("*")) {
    return candidates[0] ?? "heartbeat";
  }
  if (candidates.length > 0 && allowList.length > 0) {
    const matched = candidates.find((candidate) => allowList.includes(candidate));
    if (matched) {
      return matched;
    }
  }
  if (candidates.length > 0 && allowList.length === 0) {
    return candidates[0];
  }
  if (allowList.length > 0) {
    return allowList[0];
  }
  return candidates[0] ?? "heartbeat";
}

export function resolveHeartbeatSenderContext(params: {
  cfg: OpenClawConfig;
  entry?: SessionEntry;
  delivery: OutboundTarget;
}): HeartbeatSenderContext {
  const provider =
    params.delivery.channel !== "none" ? params.delivery.channel : params.delivery.lastChannel;
  const accountId =
    params.delivery.accountId ??
    (provider === params.delivery.lastChannel ? params.delivery.lastAccountId : undefined);
  const allowFromRaw = provider
    ? (getChannelPlugin(provider)?.config.resolveAllowFrom?.({
        cfg: params.cfg,
        accountId,
      }) ?? [])
    : [];
  const allowFrom = allowFromRaw.map((entry) => String(entry));

  const sender = resolveHeartbeatSenderId({
    allowFrom,
    deliveryTo: params.delivery.to,
    lastTo: params.entry?.lastTo,
    provider,
  });

  return { sender, provider, allowFrom };
}
