import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveUserTimezone } from "../agents/date-time.js";
import { normalizeChatType } from "../channels/chat-type.js";
import { resolveSenderLabel, type SenderLabelParams } from "../channels/sender-label.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveTimezone,
  formatUtcTimestamp,
  formatZonedTimestamp,
} from "../infra/format-time/format-datetime.ts";
import { formatTimeAgo } from "../infra/format-time/format-relative.ts";

export type AgentEnvelopeParams = {
  channel: string;
  from?: string;
  timestamp?: number | Date;
  host?: string;
  ip?: string;
  body: string;
  previousTimestamp?: number | Date;
  envelope?: EnvelopeFormatOptions;
};

/** User/config-facing controls for timestamp rendering in prompt envelopes. */
export type EnvelopeFormatOptions = {
  /**
   * "local" (default), "utc", "user", or an explicit IANA timezone string.
   */
  timezone?: string;
  /**
   * Include absolute timestamps in the envelope (default: true).
   */
  includeTimestamp?: boolean;
  /**
   * Include elapsed time suffix when previousTimestamp is provided (default: true).
   */
  includeElapsed?: boolean;
  /**
   * Optional user timezone used when timezone="user".
   */
  userTimezone?: string;
};

type ResolvedEnvelopeTimezone =
  | { mode: "utc" }
  | { mode: "local" }
  | { mode: "iana"; timeZone: string };

function sanitizeEnvelopeHeaderPart(value: string): string {
  // Header parts are metadata and must not be able to break the bracketed prefix.
  // Keep ASCII; collapse newlines/whitespace; neutralize brackets.
  return value.replaceAll("[", "(").replaceAll("]", ")").replace(/\s+/g, " ").trim();
}

/** Resolves envelope formatting defaults from agent config. */
export function resolveEnvelopeFormatOptions(cfg?: OpenClawConfig): EnvelopeFormatOptions {
  const defaults = cfg?.agents?.defaults;
  const configuredTimezone = normalizeOptionalString(defaults?.userTimezone);
  return {
    timezone: configuredTimezone ? (resolveTimezone(configuredTimezone) ?? "local") : undefined,
    includeTimestamp: true,
    includeElapsed: true,
    userTimezone: defaults?.userTimezone,
  };
}

function resolveEnvelopeTimezone(options?: EnvelopeFormatOptions): ResolvedEnvelopeTimezone {
  const trimmed = normalizeOptionalString(options?.timezone);
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
    return { mode: "iana", timeZone: resolveUserTimezone(options?.userTimezone) };
  }
  const explicit = resolveTimezone(trimmed);
  return explicit ? { mode: "iana", timeZone: explicit } : { mode: "utc" };
}

let utcWeekdayFormatter:
  | {
      dateTimeFormatConstructor: typeof Intl.DateTimeFormat;
      formatter: Intl.DateTimeFormat;
    }
  | undefined;

/** Formats an envelope timestamp using local, UTC, user, or explicit IANA timezone rules. */
export function formatAgentEnvelopeTimestamp(
  ts: number | Date | undefined,
  options?: EnvelopeFormatOptions,
): string | undefined {
  if (ts === undefined || options?.includeTimestamp === false) {
    return undefined;
  }
  const date = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  const zone = resolveEnvelopeTimezone(options);
  // Include the weekday so models do not need to derive it from the date.
  if (zone.mode !== "utc") {
    return formatZonedTimestamp(date, {
      timeZone: zone.mode === "iana" ? zone.timeZone : undefined,
      displaySeconds: true,
      displayWeekday: true,
    });
  }
  const formatted = formatUtcTimestamp(date, { displaySeconds: true });
  try {
    const DateTimeFormat = Intl.DateTimeFormat;
    const cached = utcWeekdayFormatter;
    const formatter =
      cached?.dateTimeFormatConstructor === DateTimeFormat
        ? cached.formatter
        : new DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" });
    const weekday = formatter.format(date);
    if (formatter !== cached?.formatter) {
      utcWeekdayFormatter = { dateTimeFormatConstructor: DateTimeFormat, formatter };
    }
    return `${weekday} ${formatted}`;
  } catch {
    return formatted;
  }
}

function resolveDirectEnvelopeBodyLabel(from: string | undefined): string {
  const label = sanitizeEnvelopeHeaderPart(from || "");
  const idMarkerIndex = label.search(/\s+id:/i);
  const displayLabel = idMarkerIndex > 0 ? label.slice(0, idMarkerIndex).trim() : label;
  return displayLabel.includes(":") ? "(sender)" : displayLabel;
}

/** Formats the generic bracketed envelope prepended to agent-visible messages. */
export function formatAgentEnvelope(params: AgentEnvelopeParams): string {
  const channel = sanitizeEnvelopeHeaderPart(normalizeOptionalString(params.channel) || "Channel");
  const parts: string[] = [channel];
  let elapsed: string | undefined;
  if (params.envelope?.includeElapsed !== false && params.timestamp && params.previousTimestamp) {
    const currentMs =
      params.timestamp instanceof Date ? params.timestamp.getTime() : params.timestamp;
    const previousMs =
      params.previousTimestamp instanceof Date
        ? params.previousTimestamp.getTime()
        : params.previousTimestamp;
    const elapsedMs = currentMs - previousMs;
    elapsed =
      Number.isFinite(elapsedMs) && elapsedMs >= 0
        ? formatTimeAgo(elapsedMs, { suffix: false })
        : undefined;
  }
  const from = normalizeOptionalString(params.from);
  if (from) {
    const fromLabel = sanitizeEnvelopeHeaderPart(from);
    parts.push(elapsed ? `${fromLabel} +${elapsed}` : fromLabel);
  } else if (elapsed) {
    parts.push(`+${elapsed}`);
  }
  for (const value of [params.host, params.ip]) {
    const normalized = normalizeOptionalString(value);
    if (normalized) {
      parts.push(sanitizeEnvelopeHeaderPart(normalized));
    }
  }
  const ts = formatAgentEnvelopeTimestamp(params.timestamp, params.envelope);
  if (ts) {
    parts.push(ts);
  }
  const header = `[${parts.join(" ")}]`;
  return `${header} ${params.body}`;
}

/** Formats an inbound message body with sender attribution appropriate for direct/group chats. */
export function formatInboundEnvelope(params: {
  channel: string;
  from: string;
  body: string;
  timestamp?: number | Date;
  chatType?: string;
  senderLabel?: string;
  sender?: SenderLabelParams;
  previousTimestamp?: number | Date;
  envelope?: EnvelopeFormatOptions;
  fromMe?: boolean;
}): string {
  const chatType = normalizeChatType(params.chatType);
  const isDirect = !chatType || chatType === "direct";
  const resolvedSenderRaw =
    normalizeOptionalString(params.senderLabel) || resolveSenderLabel(params.sender ?? {});
  const resolvedSender = resolvedSenderRaw ? sanitizeEnvelopeHeaderPart(resolvedSenderRaw) : "";
  const directSender = resolveDirectEnvelopeBodyLabel(normalizeOptionalString(params.from));
  const body =
    isDirect && params.fromMe
      ? `(self): ${params.body}`
      : isDirect && directSender
        ? `${directSender}: ${params.body}`
        : !isDirect && resolvedSender
          ? `${resolvedSender}: ${params.body}`
          : params.body;
  return formatAgentEnvelope({
    channel: params.channel,
    from: params.from,
    timestamp: params.timestamp,
    previousTimestamp: params.previousTimestamp,
    envelope: params.envelope,
    body,
  });
}

/** Builds the compact `from` label used in inbound envelope headers. */
export function formatInboundFromLabel(params: {
  isGroup: boolean;
  groupLabel?: string;
  groupId?: string;
  directLabel: string;
  directId?: string;
  groupFallback?: string;
}): string {
  // Keep envelope headers compact: group labels include id, DMs only add id when it differs.
  if (params.isGroup) {
    const label = normalizeOptionalString(params.groupLabel) || params.groupFallback || "Group";
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
