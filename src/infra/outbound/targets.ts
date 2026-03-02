import { normalizeChatType, type ChatType } from "../../channels/chat-type.js";
import type { ChannelOutboundTargetMode } from "../../channels/plugins/types.js";
import { formatCliCommand } from "../../cli/command-format.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
import { parseDiscordTarget } from "../../discord/targets.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import { parseSlackTarget } from "../../slack/targets.js";
import { parseTelegramTarget, resolveTelegramTargetChatType } from "../../telegram/targets.js";
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
import { isWhatsAppGroupJid, normalizeWhatsAppTarget } from "../../whatsapp/normalize.js";
import {
  normalizeDeliverableOutboundChannel,
  resolveOutboundChannelPlugin,
} from "./channel-resolution.js";
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
  /**
   * When set, this overrides the session-level `lastChannel` for "last"
   * resolution.  This prevents cross-channel reply routing when multiple
   * channels share the same session (dmScope = "main") and an inbound
   * message from a different channel updates `lastChannel` while an agent
   * turn is still in flight.
   *
   * Callers should set this to the channel that originated the current
   * agent turn so the reply always routes back to the correct channel.
   *
   * @see https://github.com/openclaw/openclaw/issues/24152
   */
  turnSourceChannel?: DeliverableMessageChannel;
  /** Turn-source `to` — paired with `turnSourceChannel`. */
  turnSourceTo?: string;
  /** Turn-source `accountId` — paired with `turnSourceChannel`. */
  turnSourceAccountId?: string;
  /** Turn-source `threadId` — paired with `turnSourceChannel`. */
  turnSourceThreadId?: string | number;
}): SessionDeliveryTarget {
  const context = deliveryContextFromSession(params.entry);
  const sessionLastChannel =
    context?.channel && isDeliverableMessageChannel(context.channel) ? context.channel : undefined;

  // When a turn-source channel is provided, use only turn-scoped metadata.
  // Falling back to mutable session fields would re-introduce routing races.
  const hasTurnSourceChannel = params.turnSourceChannel != null;
  const lastChannel = hasTurnSourceChannel ? params.turnSourceChannel : sessionLastChannel;
  const lastTo = hasTurnSourceChannel ? params.turnSourceTo : context?.to;
  const lastAccountId = hasTurnSourceChannel ? params.turnSourceAccountId : context?.accountId;
  const lastThreadId = hasTurnSourceChannel ? params.turnSourceThreadId : context?.threadId;

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

  const plugin = resolveOutboundChannelPlugin({
    channel: params.channel,
    cfg: params.cfg,
  });
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
  let target: HeartbeatTarget = "none";
  if (rawTarget === "none" || rawTarget === "last") {
    target = rawTarget;
  } else if (typeof rawTarget === "string") {
    const normalized = normalizeDeliverableOutboundChannel(rawTarget);
    if (normalized) {
      target = normalized;
    }
  }

  if (target === "none") {
    const base = resolveSessionDeliveryTarget({ entry });
    return buildNoHeartbeatDeliveryTarget({
      reason: "target-none",
      lastChannel: base.lastChannel,
      lastAccountId: base.lastAccountId,
    });
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
    const plugin = resolveOutboundChannelPlugin({
      channel: resolvedTarget.channel,
      cfg,
    });
    const listAccountIds = plugin?.config.listAccountIds;
    const accountIds = listAccountIds ? listAccountIds(cfg) : [];
    if (accountIds.length > 0) {
      const normalizedAccountId = normalizeAccountId(heartbeatAccountId);
      const normalizedAccountIds = new Set(
        accountIds.map((accountId) => normalizeAccountId(accountId)),
      );
      if (!normalizedAccountIds.has(normalizedAccountId)) {
        return buildNoHeartbeatDeliveryTarget({
          reason: "unknown-account",
          accountId: normalizedAccountId,
          lastChannel: resolvedTarget.lastChannel,
          lastAccountId: resolvedTarget.lastAccountId,
        });
      }
      effectiveAccountId = normalizedAccountId;
    }
  }

  if (!resolvedTarget.channel || !resolvedTarget.to) {
    return buildNoHeartbeatDeliveryTarget({
      reason: "no-target",
      accountId: effectiveAccountId,
      lastChannel: resolvedTarget.lastChannel,
      lastAccountId: resolvedTarget.lastAccountId,
    });
  }

  const resolved = resolveOutboundTarget({
    channel: resolvedTarget.channel,
    to: resolvedTarget.to,
    cfg,
    accountId: effectiveAccountId,
    mode: "heartbeat",
  });
  if (!resolved.ok) {
    return buildNoHeartbeatDeliveryTarget({
      reason: "no-target",
      accountId: effectiveAccountId,
      lastChannel: resolvedTarget.lastChannel,
      lastAccountId: resolvedTarget.lastAccountId,
    });
  }

  const sessionChatTypeHint =
    target === "last" && !heartbeat?.to ? normalizeChatType(entry?.chatType) : undefined;
  const deliveryChatType = resolveHeartbeatDeliveryChatType({
    channel: resolvedTarget.channel,
    to: resolved.to,
    sessionChatType: sessionChatTypeHint,
  });
  if (deliveryChatType === "direct" && heartbeat?.directPolicy === "block") {
    return buildNoHeartbeatDeliveryTarget({
      reason: "dm-blocked",
      accountId: effectiveAccountId,
      lastChannel: resolvedTarget.lastChannel,
      lastAccountId: resolvedTarget.lastAccountId,
    });
  }

  let reason: string | undefined;
  const plugin = resolveOutboundChannelPlugin({
    channel: resolvedTarget.channel,
    cfg,
  });
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

function buildNoHeartbeatDeliveryTarget(params: {
  reason: string;
  accountId?: string;
  lastChannel?: DeliverableMessageChannel;
  lastAccountId?: string;
}): OutboundTarget {
  return {
    channel: "none",
    reason: params.reason,
    accountId: params.accountId,
    lastChannel: params.lastChannel,
    lastAccountId: params.lastAccountId,
  };
}

function inferDiscordTargetChatType(to: string): ChatType | undefined {
  try {
    const target = parseDiscordTarget(to, { defaultKind: "channel" });
    if (!target) {
      return undefined;
    }
    return target.kind === "user" ? "direct" : "channel";
  } catch {
    return undefined;
  }
}

function inferSlackTargetChatType(to: string): ChatType | undefined {
  const target = parseSlackTarget(to, { defaultKind: "channel" });
  if (!target) {
    return undefined;
  }
  return target.kind === "user" ? "direct" : "channel";
}

function inferTelegramTargetChatType(to: string): ChatType | undefined {
  const chatType = resolveTelegramTargetChatType(to);
  return chatType === "unknown" ? undefined : chatType;
}

function inferWhatsAppTargetChatType(to: string): ChatType | undefined {
  const normalized = normalizeWhatsAppTarget(to);
  if (!normalized) {
    return undefined;
  }
  return isWhatsAppGroupJid(normalized) ? "group" : "direct";
}

function inferSignalTargetChatType(rawTo: string): ChatType | undefined {
  let to = rawTo.trim();
  if (!to) {
    return undefined;
  }
  if (/^signal:/i.test(to)) {
    to = to.replace(/^signal:/i, "").trim();
  }
  if (!to) {
    return undefined;
  }
  const lower = to.toLowerCase();
  if (lower.startsWith("group:")) {
    return "group";
  }
  if (lower.startsWith("username:") || lower.startsWith("u:")) {
    return "direct";
  }
  return "direct";
}

const HEARTBEAT_TARGET_CHAT_TYPE_INFERERS: Partial<
  Record<DeliverableMessageChannel, (to: string) => ChatType | undefined>
> = {
  discord: inferDiscordTargetChatType,
  slack: inferSlackTargetChatType,
  telegram: inferTelegramTargetChatType,
  whatsapp: inferWhatsAppTargetChatType,
  signal: inferSignalTargetChatType,
};

function inferChatTypeFromTarget(params: {
  channel: DeliverableMessageChannel;
  to: string;
}): ChatType | undefined {
  const to = params.to.trim();
  if (!to) {
    return undefined;
  }

  if (/^user:/i.test(to)) {
    return "direct";
  }
  if (/^(channel:|thread:)/i.test(to)) {
    return "channel";
  }
  if (/^group:/i.test(to)) {
    return "group";
  }
  return HEARTBEAT_TARGET_CHAT_TYPE_INFERERS[params.channel]?.(to);
}

function resolveHeartbeatDeliveryChatType(params: {
  channel: DeliverableMessageChannel;
  to: string;
  sessionChatType?: ChatType;
}): ChatType | undefined {
  if (params.sessionChatType) {
    return params.sessionChatType;
  }
  return inferChatTypeFromTarget({
    channel: params.channel,
    to: params.to,
  });
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
    ? (resolveOutboundChannelPlugin({
        channel: provider,
        cfg: params.cfg,
      })?.config.resolveAllowFrom?.({
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
