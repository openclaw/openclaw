import { listChannelPlugins } from "../channels/plugins/index.js";
import type {
  ChannelAccountSnapshot,
  ChannelStatusIssue,
} from "../channels/plugins/types.public.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function collectBlueBubblesPayloadIssues(accounts: unknown): ChannelStatusIssue[] {
  if (!Array.isArray(accounts)) {
    return [];
  }
  const issues: ChannelStatusIssue[] = [];
  for (const account of accounts) {
    const record = asRecord(account);
    if (!record) {
      continue;
    }
    const probe = asRecord(record.probe);
    if (!probe) {
      continue;
    }
    if (probe.ok !== false && probe.privateApi === true && probe.helperConnected === false) {
      issues.push({
        channel: "bluebubbles",
        accountId: asString(record.accountId) ?? "default",
        kind: "runtime",
        message: "BlueBubbles Private API is enabled, but the helper is disconnected.",
        fix: "Open BlueBubbles Private API settings and restart the Messages helper/server. If it stays disconnected, verify the BlueBubbles Private API prerequisites (SIP and Library Validation). Until it reconnects, sends may use the local imsg fallback and Private API-only features such as reply threading/effects are unavailable.",
      });
    }
  }
  return issues;
}

export function collectChannelStatusIssues(payload: Record<string, unknown>): ChannelStatusIssue[] {
  const issues: ChannelStatusIssue[] = [];
  const accountsByChannel = payload.channelAccounts as Record<string, unknown> | undefined;
  const channelsWithPluginCollectors = new Set<string>();
  for (const plugin of listChannelPlugins()) {
    const collect = plugin.status?.collectStatusIssues;
    if (!collect) {
      continue;
    }
    const raw = accountsByChannel?.[plugin.id];
    if (!Array.isArray(raw)) {
      continue;
    }

    channelsWithPluginCollectors.add(plugin.id);
    issues.push(...collect(raw as ChannelAccountSnapshot[]));
  }

  // CLI status often formats gateway-provided payloads without loading every
  // bundled plugin locally. Keep high-value runtime caveats visible even when
  // the plugin-specific collector is unavailable in the CLI process.
  if (!channelsWithPluginCollectors.has("bluebubbles")) {
    issues.push(...collectBlueBubblesPayloadIssues(accountsByChannel?.bluebubbles));
  }
  return issues;
}
