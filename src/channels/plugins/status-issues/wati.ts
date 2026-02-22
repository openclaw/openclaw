import type { ChannelAccountSnapshot, ChannelStatusIssue } from "../types.js";
import { asString, isRecord, resolveEnabledConfiguredAccountId } from "./shared.js";

type WatiAccountStatus = {
  accountId?: unknown;
  enabled?: unknown;
  configured?: unknown;
  webhookUrl?: unknown;
  port?: unknown;
};

function readWatiAccountStatus(value: ChannelAccountSnapshot): WatiAccountStatus | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    accountId: value.accountId,
    enabled: value.enabled,
    configured: value.configured,
    webhookUrl: value.webhookUrl,
    port: value.port,
  };
}

export function collectWatiStatusIssues(accounts: ChannelAccountSnapshot[]): ChannelStatusIssue[] {
  const issues: ChannelStatusIssue[] = [];
  const seenPorts = new Set<number>();

  for (const entry of accounts) {
    const account = readWatiAccountStatus(entry);
    if (!account) {
      continue;
    }
    const accountId = resolveEnabledConfiguredAccountId(account);
    if (!accountId) {
      continue;
    }

    // Check for missing API token (configured === false means no token)
    if (account.configured === false) {
      issues.push({
        channel: "wati",
        accountId,
        kind: "auth",
        message: "WATI API token not configured.",
        fix: "Set channels.wati.apiToken in config or WATI_API_TOKEN in env.",
      });
    }

    // Check for missing webhook URL in production
    const webhookUrl = asString(account.webhookUrl);
    if (!webhookUrl && process.env.NODE_ENV === "production") {
      issues.push({
        channel: "wati",
        accountId,
        kind: "config",
        message: "No webhook URL configured. Inbound messages will not be received in production.",
        fix: "Set channels.wati.webhookUrl to your public callback URL.",
      });
    }

    // Check for webhook port conflicts across accounts
    const port =
      typeof account.port === "number" && Number.isFinite(account.port) ? account.port : undefined;
    if (port != null) {
      if (seenPorts.has(port)) {
        issues.push({
          channel: "wati",
          accountId,
          kind: "config",
          message: `Webhook port ${port} is used by another WATI account.`,
          fix: "Assign unique webhookPort values to each WATI account.",
        });
      }
      seenPorts.add(port);
    }
  }

  return issues;
}
