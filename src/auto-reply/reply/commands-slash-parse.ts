/** Shared parser for slash commands with action and argument tails. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/** Matches a whole, case-insensitive command token and preserves its argument text. */
export function matchSlashCommandToken(raw: string, command: string): string | null {
  const trimmed = raw.trim();
  const commandEnd = trimmed.search(/\s/);
  const token = commandEnd === -1 ? trimmed : trimmed.slice(0, commandEnd);
  return token.toLowerCase() === command
    ? commandEnd === -1
      ? ""
      : trimmed.slice(commandEnd).trim()
    : null;
}

/** Parses a normalized send-policy command without importing command runtime state. */
export function parseSendPolicyCommandBody(normalized: string): {
  hasCommand: boolean;
  mode?: "allow" | "deny" | "inherit";
} {
  const match = normalized.match(/^\/send(?:\s+([a-zA-Z]+))?\s*$/i);
  if (!match) {
    return { hasCommand: false };
  }
  const token = normalizeLowercaseStringOrEmpty(match[1]);
  if (!token) {
    return { hasCommand: true };
  }
  if (token === "inherit" || token === "default" || token === "reset") {
    return { hasCommand: true, mode: "inherit" };
  }
  const mode =
    token === "allow" || token === "on"
      ? "allow"
      : token === "deny" || token === "off"
        ? "deny"
        : undefined;
  return { hasCommand: true, mode };
}

/** Parses a slash command or returns null when the prefix does not match. */
export function parseSlashCommandOrNull(
  raw: string,
  slash: string,
  defaultAction = "show",
): { action: string; args: string } | null {
  const trimmed = raw.trim();
  const slashLower = normalizeLowercaseStringOrEmpty(slash);
  if (!normalizeLowercaseStringOrEmpty(trimmed).startsWith(slashLower)) {
    return null;
  }
  // Longer command names such as `/config-check` belong to their own handler.
  const charAfter = trimmed.charAt(slash.length);
  if (charAfter && !/[\s:]/.test(charAfter)) {
    return null;
  }
  const rest = trimmed.slice(slash.length).trim();
  if (!rest) {
    return { action: defaultAction, args: "" };
  }
  const actionEnd = rest.search(/\s/);
  return {
    action: (actionEnd === -1 ? rest : rest.slice(0, actionEnd)).toLowerCase(),
    args: actionEnd === -1 ? "" : rest.slice(actionEnd).trim(),
  };
}
