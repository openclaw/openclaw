import type { ChannelAccountSnapshot, ChannelStatusIssue } from "../types.js";
import { asString, isRecord } from "./shared.js";

type ZaloAccountStatus = {
  accountId?: unknown;
  enabled?: unknown;
  configured?: unknown;
  dmPolicy?: unknown;
};

function readZaloAccountStatus(
  value: ChannelAccountSnapshot,
): ZaloAccountStatus | null {
  if (!isRecord(value)) return null;
  return {
    accountId: value.accountId,
    enabled: value.enabled,
    configured: value.configured,
    dmPolicy: value.dmPolicy,
  };
}

export function collectZaloStatusIssues(
  accounts: ChannelAccountSnapshot[],
): ChannelStatusIssue[] {
  const issues: ChannelStatusIssue[] = [];
  for (const entry of accounts) {
    const account = readZaloAccountStatus(entry);
    if (!account) continue;
    const accountId = asString(account.accountId) ?? "default";
    const enabled = account.enabled !== false;
    const configured = account.configured === true;
    if (!enabled || !configured) continue;

    // Warn if dmPolicy is "open" - anyone can message the bot
    if (account.dmPolicy === "open") {
      issues.push({
        channel: "zalo",
        accountId,
        kind: "config",
        message:
          'Zalo dmPolicy is "open", allowing any user to message the bot without pairing.',
        fix: 'Set channels.zalo.dmPolicy to "pairing" or "allowlist" to restrict access.',
      });
    }
  }
  return issues;
}
