import { normalizeChatType } from "../../channels/chat-type.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { parseDiscordTarget } from "../../discord/targets.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import { parseSlackTarget } from "../../slack/targets.js";
import { parseTelegramTarget, resolveTelegramTargetChatType } from "../../telegram/targets.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.js";
import { INTERNAL_MESSAGE_CHANNEL, isDeliverableMessageChannel, normalizeMessageChannel, } from "../../utils/message-channel.js";
import { isWhatsAppGroupJid, normalizeWhatsAppTarget } from "../../whatsapp/normalize.js";
import { normalizeDeliverableOutboundChannel, resolveOutboundChannelPlugin, } from "./channel-resolution.js";
import { missingTargetError } from "./target-errors.js";
export function resolveSessionDeliveryTarget(params) {
    const context = deliveryContextFromSession(params.entry);
    const sessionLastChannel = context?.channel && isDeliverableMessageChannel(context.channel) ? context.channel : undefined;
    // When a turn-source channel is provided, use only turn-scoped metadata.
    // Falling back to mutable session fields would re-introduce routing races.
    const hasTurnSourceChannel = params.turnSourceChannel != null;
    const lastChannel = hasTurnSourceChannel ? params.turnSourceChannel : sessionLastChannel;
    const lastTo = hasTurnSourceChannel ? params.turnSourceTo : context?.to;
    const lastAccountId = hasTurnSourceChannel ? params.turnSourceAccountId : context?.accountId;
    const lastThreadId = hasTurnSourceChannel ? params.turnSourceThreadId : context?.threadId;
    const rawRequested = params.requestedChannel ?? "last";
    const requested = rawRequested === "last" ? "last" : normalizeMessageChannel(rawRequested);
    const requestedChannel = requested === "last"
        ? "last"
        : requested && isDeliverableMessageChannel(requested)
            ? requested
            : undefined;
    const rawExplicitTo = typeof params.explicitTo === "string" && params.explicitTo.trim()
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
    let parsedThreadId;
    if (isTelegramContext && rawExplicitTo && rawExplicitTo.includes(":topic:")) {
        const parsed = parseTelegramTarget(rawExplicitTo);
        explicitTo = parsed.chatId;
        parsedThreadId = parsed.messageThreadId;
    }
    const explicitThreadId = params.explicitThreadId != null && params.explicitThreadId !== ""
        ? params.explicitThreadId
        : parsedThreadId;
    let to = explicitTo;
    if (!to && lastTo) {
        if (channel && channel === lastChannel) {
            to = lastTo;
        }
        else if (params.allowMismatchedLastTo) {
            to = lastTo;
        }
    }
    const mode = params.mode ?? (explicitTo ? "explicit" : "implicit");
    const accountId = channel && channel === lastChannel ? lastAccountId : undefined;
    const threadId = mode !== "heartbeat" && channel && channel === lastChannel ? lastThreadId : undefined;
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
export function resolveOutboundTarget(params) {
    if (params.channel === INTERNAL_MESSAGE_CHANNEL) {
        return {
            ok: false,
            error: new Error(`Delivering to WebChat is not supported via \`${formatCliCommand("openclaw agent")}\`; use WhatsApp/Telegram or run with --deliver=false.`),
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
    const allowFromRaw = params.allowFrom ??
        (params.cfg && plugin.config.resolveAllowFrom
            ? plugin.config.resolveAllowFrom({
                cfg: params.cfg,
                accountId: params.accountId ?? undefined,
            })
            : undefined);
    const allowFrom = allowFromRaw?.map((entry) => String(entry));
    // Fall back to per-channel defaultTo when no explicit target is provided.
    const effectiveTo = params.to?.trim() ||
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
export function resolveHeartbeatDeliveryTarget(params) {
    const { cfg, entry } = params;
    const heartbeat = params.heartbeat ?? cfg.agents?.defaults?.heartbeat;
    const rawTarget = heartbeat?.target;
    let target = "none";
    if (rawTarget === "none" || rawTarget === "last") {
        target = rawTarget;
    }
    else if (typeof rawTarget === "string") {
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
            const normalizedAccountIds = new Set(accountIds.map((accountId) => normalizeAccountId(accountId)));
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
    const sessionChatTypeHint = target === "last" && !heartbeat?.to ? normalizeChatType(entry?.chatType) : undefined;
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
    let reason;
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
function buildNoHeartbeatDeliveryTarget(params) {
    return {
        channel: "none",
        reason: params.reason,
        accountId: params.accountId,
        lastChannel: params.lastChannel,
        lastAccountId: params.lastAccountId,
    };
}
function inferDiscordTargetChatType(to) {
    try {
        const target = parseDiscordTarget(to, { defaultKind: "channel" });
        if (!target) {
            return undefined;
        }
        return target.kind === "user" ? "direct" : "channel";
    }
    catch {
        return undefined;
    }
}
function inferSlackTargetChatType(to) {
    const target = parseSlackTarget(to, { defaultKind: "channel" });
    if (!target) {
        return undefined;
    }
    return target.kind === "user" ? "direct" : "channel";
}
function inferTelegramTargetChatType(to) {
    const chatType = resolveTelegramTargetChatType(to);
    return chatType === "unknown" ? undefined : chatType;
}
function inferWhatsAppTargetChatType(to) {
    const normalized = normalizeWhatsAppTarget(to);
    if (!normalized) {
        return undefined;
    }
    return isWhatsAppGroupJid(normalized) ? "group" : "direct";
}
function inferSignalTargetChatType(rawTo) {
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
const HEARTBEAT_TARGET_CHAT_TYPE_INFERERS = {
    discord: inferDiscordTargetChatType,
    slack: inferSlackTargetChatType,
    telegram: inferTelegramTargetChatType,
    whatsapp: inferWhatsAppTargetChatType,
    signal: inferSignalTargetChatType,
};
function inferChatTypeFromTarget(params) {
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
function resolveHeartbeatDeliveryChatType(params) {
    if (params.sessionChatType) {
        return params.sessionChatType;
    }
    return inferChatTypeFromTarget({
        channel: params.channel,
        to: params.to,
    });
}
function resolveHeartbeatSenderId(params) {
    const { allowFrom, deliveryTo, lastTo, provider } = params;
    const candidates = [
        deliveryTo?.trim(),
        provider && deliveryTo ? `${provider}:${deliveryTo}` : undefined,
        lastTo?.trim(),
        provider && lastTo ? `${provider}:${lastTo}` : undefined,
    ].filter((val) => Boolean(val?.trim()));
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
export function resolveHeartbeatSenderContext(params) {
    const provider = params.delivery.channel !== "none" ? params.delivery.channel : params.delivery.lastChannel;
    const accountId = params.delivery.accountId ??
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
