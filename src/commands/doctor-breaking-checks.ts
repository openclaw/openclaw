import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveOpenProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
} from "../config/runtime-group-policy.js";
import { normalizeAccountId } from "../routing/session-key.js";
import { listTelegramAccountIds, resolveTelegramAccount } from "../telegram/accounts.js";
import { note } from "../terminal/note.js";

export type DoctorBreakingChangeCheck = {
  id: string;
  introducedIn: string;
  collectWarnings: (cfg: OpenClawConfig) => string[];
};

function hasEffectiveTelegramAllowEntries(entries?: Array<string | number>): boolean {
  return (entries ?? []).some((entry) => {
    const value = String(entry).trim();
    if (!value) {
      return false;
    }
    if (value === "*") {
      return true;
    }
    return /^\d+$/.test(value.replace(/^(telegram|tg):/i, ""));
  });
}

function hasAccountConfigEntry(cfg: OpenClawConfig, accountId: string): boolean {
  const accounts = cfg.channels?.telegram?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return false;
  }
  const normalizedAccountId = normalizeAccountId(accountId);
  return Object.keys(accounts).some((key) => normalizeAccountId(key) === normalizedAccountId);
}

function collectTelegramGroupAllowlistUpgradeWarnings(cfg: OpenClawConfig): string[] {
  const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
  const warnings: string[] = [];

  for (const accountId of listTelegramAccountIds(cfg)) {
    const account = resolveTelegramAccount({ cfg, accountId });
    if (!account.enabled || account.tokenSource === "none") {
      continue;
    }

    const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
      providerConfigPresent: cfg.channels?.telegram !== undefined,
      groupPolicy: account.config.groupPolicy,
      defaultGroupPolicy,
    });
    if (groupPolicy !== "allowlist") {
      continue;
    }

    const hasScopedChatOverrides = Object.values(account.config.groups ?? {}).some((group) => {
      if (group?.groupPolicy === "open" || hasEffectiveTelegramAllowEntries(group?.allowFrom)) {
        return true;
      }
      return Object.values(group?.topics ?? {}).some(
        (topic) =>
          topic?.groupPolicy === "open" || hasEffectiveTelegramAllowEntries(topic?.allowFrom),
      );
    });
    const hasAccountSenderAllowlist =
      typeof account.config.groupAllowFrom !== "undefined"
        ? hasEffectiveTelegramAllowEntries(account.config.groupAllowFrom)
        : hasEffectiveTelegramAllowEntries(account.config.allowFrom);
    if (hasAccountSenderAllowlist) {
      continue;
    }

    const useAccountPath = hasAccountConfigEntry(cfg, account.accountId);
    const basePath = useAccountPath
      ? `channels.telegram.accounts.${account.accountId}`
      : "channels.telegram";

    const impact = hasScopedChatOverrides
      ? `only chats with explicit per-group/per-topic open or allowFrom overrides will work until you configure ${basePath}.groupAllowFrom with numeric sender IDs.`
      : `group senders will be blocked until you configure ${basePath}.groupAllowFrom (or per-group/per-topic allowFrom) with numeric sender IDs.`;

    warnings.push(
      `- [2026.2.25] Telegram account "${account.accountId}": groupPolicy resolves to "allowlist" but no account-level sender allowlist is configured; ${impact}`,
    );
  }

  return warnings;
}

export const DOCTOR_BREAKING_CHANGE_CHECKS: readonly DoctorBreakingChangeCheck[] = [
  {
    id: "telegram-group-allowlist-migration",
    introducedIn: "2026.2.25",
    collectWarnings: collectTelegramGroupAllowlistUpgradeWarnings,
  },
] as const;

export function collectBreakingChangeUpgradeWarnings(cfg: OpenClawConfig): string[] {
  const lines: string[] = [];
  for (const check of DOCTOR_BREAKING_CHANGE_CHECKS) {
    lines.push(...check.collectWarnings(cfg));
  }
  return lines;
}

export function noteBreakingChangeUpgradeWarnings(cfg: OpenClawConfig): void {
  const warnings = collectBreakingChangeUpgradeWarnings(cfg);
  if (warnings.length === 0) {
    return;
  }

  const lines = [
    ...warnings,
    `- See release notes for migration context, then re-run ${formatCliCommand("openclaw doctor")} after applying changes.`,
  ];
  note(lines.join("\n"), "Upgrade");
}
