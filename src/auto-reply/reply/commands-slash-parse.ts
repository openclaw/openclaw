import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/** Splits trimmed command text without normalizing the remaining arguments. */
export function splitCommandAction(trimmed: string, defaultAction = "") {
  const actionEnd = trimmed.search(/\s/);
  return {
    action:
      (actionEnd === -1 ? trimmed : trimmed.slice(0, actionEnd)).toLowerCase() || defaultAction,
    args: actionEnd === -1 ? "" : trimmed.slice(actionEnd).trim(),
  };
}

/** Matches a whole, case-insensitive command token and preserves its argument text. */
export function matchSlashCommandToken(raw: string, command: string): string | null {
  const { action, args } = splitCommandAction(raw.trim());
  return action === command ? args : null;
}

export function resolveSlashCommandName(commandBody: string): string | null {
  const match = commandBody.trim().match(/^\/([^\s:]+)(?::|\s|$)/);
  return normalizeLowercaseStringOrEmpty(match?.[1]) || null;
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
  return splitCommandAction(trimmed.slice(slash.length).trim(), defaultAction);
}
