import { parseDurationMs } from "../../cli/parse-duration.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";

export type MessagingWindowCommand =
  | { action: "status" }
  | { action: "set"; scope: "global"; debounceMs: number }
  | { action: "set"; scope: "channel"; channel: string; debounceMs: number }
  | { action: "reset"; scope: "global" }
  | { action: "reset"; scope: "channel"; channel: string }
  | { action: "error"; message: string };

const ALIASES = ["/messaging_window", "/messaging-window"];

const USAGE =
  "Usage: /messaging_window status | <duration|off> | global <duration|off> | <channel|current> <duration|off> | channel <name|current> <duration|off> | reset global | reset <channel|current>";

function parseWindowMs(raw: string): number | null {
  const normalized = normalizeOptionalLowercaseString(raw) ?? "";
  if (normalized === "off" || normalized === "disable" || normalized === "disabled") {
    return 0;
  }
  try {
    const parsed = parseDurationMs(normalized, { defaultUnit: "s" });
    if (!Number.isFinite(parsed) || parsed < 0) {
      return null;
    }
    return Math.round(parsed);
  } catch {
    return null;
  }
}

function parseAlias(raw: string): string | null {
  const trimmed = raw.trim();
  const lowered = normalizeOptionalLowercaseString(trimmed) ?? "";
  for (const alias of ALIASES) {
    if (lowered === alias) {
      return "";
    }
    if (lowered.startsWith(`${alias} `)) {
      return trimmed.slice(alias.length).trim();
    }
  }
  return null;
}

function parseSetScope(action: string, args: string): MessagingWindowCommand {
  if (action === "global") {
    const debounceMs = parseWindowMs(args);
    if (debounceMs == null) {
      return { action: "error", message: USAGE };
    }
    return { action: "set", scope: "global", debounceMs };
  }

  if (action === "channel") {
    const [channel, value, ...extra] = args.split(/\s+/).filter(Boolean);
    if (!channel || !value || extra.length > 0) {
      return { action: "error", message: USAGE };
    }
    const debounceMs = parseWindowMs(value);
    if (debounceMs == null) {
      return { action: "error", message: USAGE };
    }
    return { action: "set", scope: "channel", channel, debounceMs };
  }

  const [value, ...extra] = args.split(/\s+/).filter(Boolean);
  if (value && extra.length === 0) {
    const debounceMs = parseWindowMs(value);
    if (debounceMs != null) {
      return { action: "set", scope: "channel", channel: action, debounceMs };
    }
  }

  return { action: "error", message: USAGE };
}

function parseResetScope(args: string): MessagingWindowCommand {
  const [scope, channel, ...extra] = args.split(/\s+/).filter(Boolean);
  if (scope === "global" && !channel && extra.length === 0) {
    return { action: "reset", scope: "global" };
  }
  if (scope === "channel" && channel && extra.length === 0) {
    return { action: "reset", scope: "channel", channel };
  }
  if (scope && !channel && extra.length === 0) {
    return { action: "reset", scope: "channel", channel: scope };
  }
  return { action: "error", message: USAGE };
}

function parseOffScope(args: string): MessagingWindowCommand {
  const [scope, channel, ...extra] = args.split(/\s+/).filter(Boolean);
  if (!scope && !channel && extra.length === 0) {
    return { action: "set", scope: "global", debounceMs: 0 };
  }
  if (scope === "global" && !channel && extra.length === 0) {
    return { action: "set", scope: "global", debounceMs: 0 };
  }
  if (scope === "channel" && channel && extra.length === 0) {
    return { action: "set", scope: "channel", channel, debounceMs: 0 };
  }
  if (scope && !channel && extra.length === 0) {
    return { action: "set", scope: "channel", channel: scope, debounceMs: 0 };
  }
  return { action: "error", message: USAGE };
}

export function parseMessagingWindowCommand(raw: string): MessagingWindowCommand | null {
  const rest = parseAlias(raw);
  if (rest == null) {
    return null;
  }
  if (!rest) {
    return { action: "status" };
  }

  const [actionRaw, ...tail] = rest.split(/\s+/);
  const action = normalizeOptionalLowercaseString(actionRaw) ?? "";
  const args = tail.join(" ").trim();
  if (action === "status" || action === "show" || action === "get") {
    return args ? { action: "error", message: USAGE } : { action: "status" };
  }
  if (action === "reset" || action === "unset" || action === "clear") {
    return parseResetScope(args);
  }
  if (action === "off" || action === "disable" || action === "disabled") {
    return parseOffScope(args);
  }
  if (!args) {
    const debounceMs = parseWindowMs(action);
    if (debounceMs != null) {
      return { action: "set", scope: "global", debounceMs };
    }
  }
  return parseSetScope(action, args);
}
