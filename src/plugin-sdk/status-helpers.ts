import type { ChannelStatusIssue } from "../channels/plugins/types.js";

export function createDefaultChannelRuntimeState<T extends Record<string, unknown>>(
  accountId: string,
  extra?: T,
): {
  accountId: string;
  running: false;
  lastStartAt: null;
  lastStopAt: null;
  lastError: null;
} & T {
  return {
    accountId,
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
    ...(extra ?? ({} as T)),
  };
}

export function buildBaseChannelStatusSummary(snapshot: {
  configured?: boolean | null;
  running?: boolean | null;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
}) {
  return {
    configured: snapshot.configured ?? false,
    running: snapshot.running ?? false,
    lastStartAt: snapshot.lastStartAt ?? null,
    lastStopAt: snapshot.lastStopAt ?? null,
    lastError: snapshot.lastError ?? null,
  };
}

export function collectStatusIssuesFromLastError(
  channel: string,
  accounts: Array<{ accountId: string; lastError?: unknown }>,
): ChannelStatusIssue[] {
  return accounts.flatMap((account) => {
    const lastError = typeof account.lastError === "string" ? account.lastError.trim() : "";
    if (!lastError) {
      return [];
    }
    return [
      {
        channel,
        accountId: account.accountId,
        kind: "runtime",
        message: `Channel error: ${lastError}`,
      },
    ];
  });
}
