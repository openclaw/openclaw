import type { ChannelAccountSnapshot, ChannelStatusIssue } from "../types.js";

export function collectLinqStatusIssues(
  accounts: ChannelAccountSnapshot[],
): ChannelStatusIssue[] {
  return accounts.flatMap((account) => {
    const issues: ChannelStatusIssue[] = [];

    const lastError = typeof account.lastError === "string" ? account.lastError.trim() : "";
    if (lastError) {
      issues.push({
        channel: "linq",
        accountId: account.accountId,
        kind: "runtime",
        message: `Channel error: ${lastError}`,
      });
    }

    if (!account.configured) {
      issues.push({
        channel: "linq",
        accountId: account.accountId,
        kind: "config",
        message: "LINQ account not configured. Run `openclaw setup` or set channels.linq.apiToken and channels.linq.fromNumber.",
      });
    }

    return issues;
  });
}
