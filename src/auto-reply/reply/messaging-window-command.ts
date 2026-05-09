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

function splitArgs(raw: string): string[] {
  const trimmed = raw.trim();
  return trimmed ? trimmed.split(/\s+/) : [];
}

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
  const alias = ALIASES.find(
    (candidate) => lowered === candidate || lowered.startsWith(`${candidate} `),
  );
  if (!alias) {
    return null;
  }
  if (lowered === alias) {
    return "";
  }
  return trimmed.slice(alias.length).trim();
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
    const [channel, value, ...extra] = splitArgs(args);
    if (!channel || !value || extra.length > 0) {
      return { action: "error", message: USAGE };
    }
    const debounceMs = parseWindowMs(value);
    if (debounceMs == null) {
      return { action: "error", message: USAGE };
    }
    return { action: "set", scope: "channel", channel, debounceMs };
  }

  const [value, ...extra] = splitArgs(args);
  if (value && extra.length === 0) {
    const debounceMs = parseWindowMs(value);
    if (debounceMs != null) {
      return { action: "set", scope: "channel", channel: action, debounceMs };
    }
  }

  return { action: "error", message: USAGE };
}

function parseResetScope(args: string): MessagingWindowCommand {
  const [scope, channel, ...extra] = splitArgs(args);
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
  const [scope, channel, ...extra] = splitArgs(args);
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
