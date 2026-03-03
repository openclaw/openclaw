import { resolveUserTimezone } from "../agents/date-time.js";
import { normalizeChatType } from "../channels/chat-type.js";
import { resolveSenderLabel } from "../channels/sender-label.js";
import { resolveTimezone, formatUtcTimestamp, formatZonedTimestamp, } from "../infra/format-time/format-datetime.ts";
import { formatTimeAgo } from "../infra/format-time/format-relative.ts";
function sanitizeEnvelopeHeaderPart(value) {
    // Header parts are metadata and must not be able to break the bracketed prefix.
    // Keep ASCII; collapse newlines/whitespace; neutralize brackets.
    return value
        .replace(/\r\n|\r|\n/g, " ")
        .replaceAll("[", "(")
        .replaceAll("]", ")")
        .replace(/\s+/g, " ")
        .trim();
}
export function resolveEnvelopeFormatOptions(cfg) {
    const defaults = cfg?.agents?.defaults;
    return {
        timezone: defaults?.envelopeTimezone,
        includeTimestamp: defaults?.envelopeTimestamp !== "off",
        includeElapsed: defaults?.envelopeElapsed !== "off",
        userTimezone: defaults?.userTimezone,
    };
}
function normalizeEnvelopeOptions(options) {
    const includeTimestamp = options?.includeTimestamp !== false;
    const includeElapsed = options?.includeElapsed !== false;
    return {
        timezone: options?.timezone?.trim() || "local",
        includeTimestamp,
        includeElapsed,
        userTimezone: options?.userTimezone,
    };
}
function resolveEnvelopeTimezone(options) {
    const trimmed = options.timezone?.trim();
    if (!trimmed) {
        return { mode: "local" };
    }
    const lowered = trimmed.toLowerCase();
    if (lowered === "utc" || lowered === "gmt") {
        return { mode: "utc" };
    }
    if (lowered === "local" || lowered === "host") {
        return { mode: "local" };
    }
    if (lowered === "user") {
        return { mode: "iana", timeZone: resolveUserTimezone(options.userTimezone) };
    }
    const explicit = resolveTimezone(trimmed);
    return explicit ? { mode: "iana", timeZone: explicit } : { mode: "utc" };
}
function formatTimestamp(ts, options) {
    if (!ts) {
        return undefined;
    }
    const resolved = normalizeEnvelopeOptions(options);
    if (!resolved.includeTimestamp) {
        return undefined;
    }
    const date = ts instanceof Date ? ts : new Date(ts);
    if (Number.isNaN(date.getTime())) {
        return undefined;
    }
    const zone = resolveEnvelopeTimezone(resolved);
    // Include a weekday prefix so models do not need to derive DOW from the date
    // (small models are notoriously unreliable at that).
    const weekday = (() => {
        try {
            if (zone.mode === "utc") {
                return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(date);
            }
            if (zone.mode === "local") {
                return new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date);
            }
            return new Intl.DateTimeFormat("en-US", { timeZone: zone.timeZone, weekday: "short" }).format(date);
        }
        catch {
            return undefined;
        }
    })();
    const formatted = zone.mode === "utc"
        ? formatUtcTimestamp(date)
        : zone.mode === "local"
            ? formatZonedTimestamp(date)
            : formatZonedTimestamp(date, { timeZone: zone.timeZone });
    if (!formatted) {
        return undefined;
    }
    return weekday ? `${weekday} ${formatted}` : formatted;
}
export function formatAgentEnvelope(params) {
    const channel = sanitizeEnvelopeHeaderPart(params.channel?.trim() || "Channel");
    const parts = [channel];
    const resolved = normalizeEnvelopeOptions(params.envelope);
    let elapsed;
    if (resolved.includeElapsed && params.timestamp && params.previousTimestamp) {
        const currentMs = params.timestamp instanceof Date ? params.timestamp.getTime() : params.timestamp;
        const previousMs = params.previousTimestamp instanceof Date
            ? params.previousTimestamp.getTime()
            : params.previousTimestamp;
        const elapsedMs = currentMs - previousMs;
        elapsed =
            Number.isFinite(elapsedMs) && elapsedMs >= 0
                ? formatTimeAgo(elapsedMs, { suffix: false })
                : undefined;
    }
    if (params.from?.trim()) {
        const from = sanitizeEnvelopeHeaderPart(params.from.trim());
        parts.push(elapsed ? `${from} +${elapsed}` : from);
    }
    else if (elapsed) {
        parts.push(`+${elapsed}`);
    }
    if (params.host?.trim()) {
        parts.push(sanitizeEnvelopeHeaderPart(params.host.trim()));
    }
    if (params.ip?.trim()) {
        parts.push(sanitizeEnvelopeHeaderPart(params.ip.trim()));
    }
    const ts = formatTimestamp(params.timestamp, resolved);
    if (ts) {
        parts.push(ts);
    }
    const header = `[${parts.join(" ")}]`;
    return `${header} ${params.body}`;
}
export function formatInboundEnvelope(params) {
    const chatType = normalizeChatType(params.chatType);
    const isDirect = !chatType || chatType === "direct";
    const resolvedSenderRaw = params.senderLabel?.trim() || resolveSenderLabel(params.sender ?? {});
    const resolvedSender = resolvedSenderRaw ? sanitizeEnvelopeHeaderPart(resolvedSenderRaw) : "";
    const body = !isDirect && resolvedSender ? `${resolvedSender}: ${params.body}` : params.body;
    return formatAgentEnvelope({
        channel: params.channel,
        from: params.from,
        timestamp: params.timestamp,
        previousTimestamp: params.previousTimestamp,
        envelope: params.envelope,
        body,
    });
}
export function formatInboundFromLabel(params) {
    // Keep envelope headers compact: group labels include id, DMs only add id when it differs.
    if (params.isGroup) {
        const label = params.groupLabel?.trim() || params.groupFallback || "Group";
        const id = params.groupId?.trim();
        return id ? `${label} id:${id}` : label;
    }
    const directLabel = params.directLabel.trim();
    const directId = params.directId?.trim();
    if (!directId || directId === directLabel) {
        return directLabel;
    }
    return `${directLabel} id:${directId}`;
}
export function formatThreadStarterEnvelope(params) {
    return formatAgentEnvelope({
        channel: params.channel,
        from: params.author,
        timestamp: params.timestamp,
        envelope: params.envelope,
        body: params.body,
    });
}
