import type { ClawdbotConfig } from "../config/config.js";
import type { TelegramInlineButtonsScope } from "../config/types.telegram.js";
import { listTelegramAccountIds, resolveTelegramAccount } from "./accounts.js";

const DEFAULT_INLINE_BUTTONS_SCOPE: TelegramInlineButtonsScope = "allowlist";

function normalizeInlineButtonsScope(value: unknown): TelegramInlineButtonsScope | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  if (
    trimmed === "off" ||
    trimmed === "dm" ||
    trimmed === "group" ||
    trimmed === "all" ||
    trimmed === "allowlist"
  ) {
    return trimmed as TelegramInlineButtonsScope;
  }
  return undefined;
}

function resolveInlineButtonsScopeFromCapabilities(
  capabilities: unknown,
): TelegramInlineButtonsScope {
  if (!capabilities) return DEFAULT_INLINE_BUTTONS_SCOPE;
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

export function resolveTelegramInlineButtonsScope(params: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
}): TelegramInlineButtonsScope {
  const account = resolveTelegramAccount({ cfg: params.cfg, accountId: params.accountId });
  return resolveInlineButtonsScopeFromCapabilities(account.config.capabilities);
}

export function isTelegramInlineButtonsEnabled(params: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
}): boolean {
  if (params.accountId) {
    return resolveTelegramInlineButtonsScope(params) !== "off";
  }
  const accountIds = listTelegramAccountIds(params.cfg);
  if (accountIds.length === 0) {
    return resolveTelegramInlineButtonsScope(params) !== "off";
  }
  return accountIds.some(
    (accountId) => resolveTelegramInlineButtonsScope({ cfg: params.cfg, accountId }) !== "off",
  );
}

export function resolveTelegramTargetChatType(target: string): "direct" | "group" | "unknown" {
  let trimmed = target.trim();
  if (!trimmed) return "unknown";
  // Strip telegram: prefix added by normalizeTelegramMessagingTarget
  if (trimmed.toLowerCase().startsWith("telegram:")) {
    trimmed = trimmed.slice("telegram:".length).trim();
  }
  if (/^-?\d+$/.test(trimmed)) {
    return trimmed.startsWith("-") ? "group" : "direct";
  }
  return "unknown";
}
