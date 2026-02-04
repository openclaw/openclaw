import type { OpenClawConfig } from "../config/config.js";
import type { DiscordInlineButtonsScope } from "../config/types.discord.js";
import { listDiscordAccountIds, resolveDiscordAccount } from "./accounts.js";
import { parseDiscordTarget } from "./targets.js";

const DEFAULT_INLINE_BUTTONS_SCOPE: DiscordInlineButtonsScope = "allowlist";

function normalizeInlineButtonsScope(value: unknown): DiscordInlineButtonsScope | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  if (
    trimmed === "off" ||
    trimmed === "dm" ||
    trimmed === "group" ||
    trimmed === "all" ||
    trimmed === "allowlist"
  ) {
    return trimmed as DiscordInlineButtonsScope;
  }
  return undefined;
}

function resolveInlineButtonsScopeFromCapabilities(
  capabilities: unknown,
): DiscordInlineButtonsScope {
  if (!capabilities) {
    return DEFAULT_INLINE_BUTTONS_SCOPE;
  }
  if (Array.isArray(capabilities)) {
    const enabled = capabilities.some(
      (entry) => String(entry).trim().toLowerCase() === "inlinebuttons",
    );
    return enabled ? "all" : "off";
  }
  if (typeof capabilities === "object") {
    const inlineButtons = (capabilities as { inlineButtons?: unknown }).inlineButtons;
    return normalizeInlineButtonsScope(inlineButtons) ?? DEFAULT_INLINE_BUTTONS_SCOPE;
  }
  return DEFAULT_INLINE_BUTTONS_SCOPE;
}

export function resolveDiscordInlineButtonsScope(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): DiscordInlineButtonsScope {
  const account = resolveDiscordAccount({ cfg: params.cfg, accountId: params.accountId });
  return resolveInlineButtonsScopeFromCapabilities(account.config.capabilities);
}

export function isDiscordInlineButtonsEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  if (params.accountId) {
    return resolveDiscordInlineButtonsScope(params) !== "off";
  }
  const accountIds = listDiscordAccountIds(params.cfg);
  if (accountIds.length === 0) {
    return resolveDiscordInlineButtonsScope(params) !== "off";
  }
  return accountIds.some(
    (accountId) => resolveDiscordInlineButtonsScope({ cfg: params.cfg, accountId }) !== "off",
  );
}

/**
 * Resolve Discord target chat type from target string.
 * - "user:..." -> "direct"
 * - "channel:..." -> "group"
 * - bare numeric id -> "unknown" (ambiguous)
 */
export function resolveDiscordTargetChatType(target: string): "direct" | "group" | "unknown" {
  if (!target.trim()) {
    return "unknown";
  }

  try {
    // Try parsing with defaultKind to see if we can determine the type
    const parsed = parseDiscordTarget(target, { defaultKind: "channel" });
    if (!parsed) {
      return "unknown";
    }

    // If the target explicitly includes "user:" prefix, it's direct
    const trimmed = target.trim().toLowerCase();
    if (trimmed.startsWith("user:") || /^<@!?\d+>$/.test(target.trim())) {
      return "direct";
    }

    // If explicitly channel or guild channel
    if (trimmed.startsWith("channel:")) {
      return "group";
    }

    // For bare numeric IDs, we can't determine - treat as unknown
    if (/^\d+$/.test(target.trim())) {
      return "unknown";
    }

    // Default based on parsed kind
    return parsed.kind === "user" ? "direct" : "group";
  } catch {
    return "unknown";
  }
}
