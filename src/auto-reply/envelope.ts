import { resolveUserTimezone } from "../agents/date-time.js";
import { normalizeChatType } from "../channels/chat-type.js";
import { resolveSenderLabel, type SenderLabelParams } from "../channels/sender-label.js";
import type { MoltbotConfig } from "../config/config.js";

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
   * Optional user timezone used when timezone = "user".
   */
  userTimezone?: string;
  /**
   * Custom date format string (e.g., "ddd MMM D HH:mm"). Overrides default timestamp format.
   */
  dateFormat?: string;
};

type NormalizedEnvelopeOptions = {
  timezone: string;
  includeTimestamp: boolean;
  includeElapsed: boolean;
  userTimezone?: string;
  dateFormat?: string;
};

type ResolvedEnvelopeTimezone =
  | { mode: "utc" }
  | { mode: "local" }
  | { mode: "iana"; timeZone: string };

export function resolveEnvelopeFormatOptions(cfg?: MoltbotConfig): EnvelopeFormatOptions {
  const defaults = cfg?.agents?.defaults;
  return {
    timezone: defaults?.envelopeTimezone,
    includeTimestamp: defaults?.envelopeTimestamp !== "off",
    includeElapsed: defaults?.envelopeElapsed !== "off",
    userTimezone: defaults?.userTimezone,
    dateFormat: defaults?.envelopeDateFormat,
  };
}

function normalizeEnvelopeOptions(options?: EnvelopeFormatOptions): NormalizedEnvelopeOptions {
  const includeTimestamp = options?.includeTimestamp !== false;
  const includeElapsed = options?.includeElapsed !== false;
  return {
    timezone: options?.timezone?.trim() || "local",
    includeTimestamp,
    includeElapsed,
    userTimezone: options?.userTimezone,
    dateFormat: options?.dateFormat,
  };
}

function resolveExplicitTimezone(value: string): string | undefined {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return value;
  } catch {
    return undefined;
  }
}

function resolveEnvelopeTimezone(options: NormalizedEnvelopeOptions): ResolvedEnvelopeTimezone {
  const trimmed = options.timezone?.trim();
  if (!trimmed) return { mode: "local" };
  const lowered = trimmed.toLowerCase();
  if (lowered === "utc" || lowered === "gmt") return { mode: "utc" };
  if (lowered === "local" || lowered === "host") return { mode: "local" };
  if (lowered === "user") {
    return { mode: "iana", timeZone: resolveUserTimezone(options.userTimezone) };
  }
  const explicit = resolveExplicitTimezone(trimmed);
  return explicit ? { mode: "iana", timeZone: explicit } : { mode: "utc" };
}

function formatUtcTimestamp(date: Date): string {
  const yyyy = String(date.getUTCFullYear()).padStart(4, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const min = String(date.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${min}Z`;
}

function formatZonedTimestamp(date: Date, timeZone?: string): string | undefined {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value;
  const yyyy = pick("year");
  const mm = pick("month");
  const dd = pick("day");
  const hh = pick("hour");
  const min = pick("minute");
  const tz = [...parts]
    .reverse()
    .find((part) => part.type === "timeZoneName")
    ?.value?.trim();
  if (!yyyy || !mm || !dd || !hh || !min) return undefined;
  return `${yyyy}-${mm}-${dd} ${hh}:${min}${tz ? ` ${tz}` : ""}`;
}

function formatTimestamp(
  ts: number | Date | undefined,
  options?: EnvelopeFormatOptions,
): string | undefined {
  if (!ts) return undefined;
  const resolved = normalizeEnvelopeOptions(options);
  if (!resolved.includeTimestamp) return undefined;
  const date = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(date.getTime())) return undefined;
  const zone = resolveEnvelopeTimezone(resolved);
  if (resolved.dateFormat) {
    let tz: string | undefined;
    if (zone.mode === "iana") tz = zone.timeZone;
    else if (zone.mode === "utc") tz = "UTC";
    return formatDate(date, resolved.dateFormat, tz);
  }
  if (zone.mode === "utc") return formatUtcTimestamp(date);
  if (zone.mode === "local") return formatZonedTimestamp(date);
  return formatZonedTimestamp(date, zone.timeZone);
}

function formatDate(date: Date, format: string, checkTimeZone?: string): string {
  // We need to extract parts in the correct timezone
  const timeZone = checkTimeZone || undefined; // undefined = local
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
    timeZoneName: "short",
  }).formatToParts(date);

  const getPart = (type: string) => parts.find((p) => p.type === type)?.value || "";

  // Also get 12h hour and day period/ampm
  const parts12 = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hour12: true,
  }).formatToParts(date);
  const hour12 = parts12.find((p) => p.type === "hour")?.value || "";
  const dayPeriod = parts12.find((p) => p.type === "dayPeriod")?.value || "";

  const Y = getPart("year");
  const M = getPart("month"); // Long month
  const D = getPart("day");
  const d = getPart("weekday"); // Long weekday
  const H = getPart("hour").padStart(2, "0"); // 0-23
  const m = getPart("minute").padStart(2, "0");
  const s = getPart("second").padStart(2, "0");
  const z = parts.find((p) => p.type === "timeZoneName")?.value || "";

  // Helper for short month/weekday
  const MMM = M.slice(0, 3);
  const MM = new Intl.DateTimeFormat("en-US", { timeZone, month: "2-digit" }).format(date);
  const DD = D.padStart(2, "0");
  const ddd = d.slice(0, 3);
  const h = hour12.padStart(2, "0");

  const map: Record<string, string> = {
    YYYY: Y,
    MMM: MMM,
    MM: MM,
    DD: DD,
    D: D,
    dddd: d,
    ddd: ddd,
    HH: H,
    hh: h,
    mm: m,
    ss: s,
    a: dayPeriod.toLowerCase(),
    A: dayPeriod.toUpperCase(),
    z: z,
  };

  return format.replace(/YYYY|MMM|MM|DD|D|dddd|ddd|HH|hh|mm|ss|a|A|z/g, (match) => map[match]);
}

function formatElapsedTime(currentMs: number, previousMs: number): string | undefined {
  const elapsedMs = currentMs - previousMs;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return undefined;

  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function formatAgentEnvelope(params: AgentEnvelopeParams): string {
  const channel = params.channel?.trim() || "Channel";
  const parts: string[] = [channel];
  const resolved = normalizeEnvelopeOptions(params.envelope);
  const elapsed =
    resolved.includeElapsed && params.timestamp && params.previousTimestamp
      ? formatElapsedTime(
          params.timestamp instanceof Date ? params.timestamp.getTime() : params.timestamp,
          params.previousTimestamp instanceof Date
            ? params.previousTimestamp.getTime()
            : params.previousTimestamp,
        )
      : undefined;
  if (params.from?.trim()) {
    const from = params.from.trim();
    parts.push(elapsed ? `${from} +${elapsed}` : from);
  } else if (elapsed) {
    parts.push(`+${elapsed}`);
  }
  if (params.host?.trim()) parts.push(params.host.trim());
  if (params.ip?.trim()) parts.push(params.ip.trim());
  const ts = formatTimestamp(params.timestamp, resolved);
  if (ts) parts.push(ts);
  const header = `[${parts.join(" ")}]`;
  return `${header} ${params.body}`;
}

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
}): string {
  const chatType = normalizeChatType(params.chatType);
  const isDirect = !chatType || chatType === "direct";
  const resolvedSender = params.senderLabel?.trim() || resolveSenderLabel(params.sender ?? {});
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
    const label = params.groupLabel?.trim() || params.groupFallback || "Group";
    const id = params.groupId?.trim();
    return id ? `${label} id:${id}` : label;
  }

  const directLabel = params.directLabel.trim();
  const directId = params.directId?.trim();
  if (!directId || directId === directLabel) return directLabel;
  return `${directLabel} id:${directId}`;
}

export function formatThreadStarterEnvelope(params: {
  channel: string;
  author?: string;
  timestamp?: number | Date;
  body: string;
  envelope?: EnvelopeFormatOptions;
}): string {
  return formatAgentEnvelope({
    channel: params.channel,
    from: params.author,
    timestamp: params.timestamp,
    envelope: params.envelope,
    body: params.body,
  });
}
