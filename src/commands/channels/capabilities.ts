import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import { getChannelPlugin, listChannelPlugins } from "../../channels/plugins/index.js";
import type { ChannelCapabilities, ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { danger } from "../../globals.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { theme } from "../../terminal/theme.js";
import { formatChannelAccountLabel, requireValidConfig } from "./shared.js";

export type ChannelsCapabilitiesOptions = {
  channel?: string;
  account?: string;
  target?: string;
  timeout?: string;
  json?: boolean;
};

type ChannelCapabilitiesReport = {
  channel: string;
  accountId: string;
  accountName?: string;
  configured?: boolean;
  enabled?: boolean;
  support?: ChannelCapabilities;
  actions?: string[];
};

function formatChannelSummary(params: {
  channel: string;
  accountId: string;
  accountName?: string;
  configured: boolean;
  enabled: boolean;
  capabilities?: ChannelCapabilities;
  actions?: string[];
}): string {
  const { channel, accountId, accountName, configured, enabled, capabilities, actions } = params;
  const accountLabel = accountName ? `${accountId} (${accountName})` : accountId;
  const status = configured
    ? enabled
      ? theme.success("enabled")
      : theme.warning("disabled")
    : theme.danger("not configured");
  const lines = [`${theme.bold(channel)} — ${accountLabel}: ${status}`];
  if (capabilities) {
    const chatTypes = capabilities.chatTypes?.join(", ") || "none";
    lines.push(`  Chat types: ${chatTypes}`);
    if (capabilities.nativeCommands) {
      lines.push(`  Native commands: ${theme.success("yes")}`);
    }
    if (capabilities.blockStreaming) {
      lines.push(`  Block streaming: ${theme.success("yes")}`);
    }
  }
  if (actions && actions.length > 0) {
    lines.push(`  Actions: ${actions.join(", ")}`);
  }
  return lines.join("\n");
}

export async function runChannelsCapabilities(
  opts: ChannelsCapabilitiesOptions,
  env: RuntimeEnv = defaultRuntime,
): Promise<string> {
  const cfg = requireValidConfig(opts);
  const channelFilter = opts.channel?.trim();
  const accountFilter = opts.account?.trim();
  const channels = listChannelPlugins();
  const reports: ChannelCapabilitiesReport[] = [];

  for (const entry of channels) {
    const channelId = String(entry.plugin.id);
    if (channelFilter && channelId !== channelFilter) {
      continue;
    }

    const accountId = resolveChannelDefaultAccountId({
      channel: channelId,
      cfg,
      accountId: accountFilter,
    });

    const accountName =
      channelId === "telegram"
        ? cfg.channels?.telegram?.accounts?.[accountId]?.name
        : channelId === "feishu"
          ? cfg.channels?.feishu?.accounts?.[accountId]?.name
          : undefined;

    const configured = Boolean(
      channelId === "telegram"
        ? cfg.channels?.telegram?.accounts?.[accountId]?.token
        : channelId === "feishu"
          ? cfg.channels?.feishu?.accounts?.[accountId]?.appId
          : null,
    );

    const enabled =
      cfg.channels?.[channelId]?.accounts?.[accountId]?.enabled ??
      cfg.channels?.[channelId]?.enabled ??
      true;

    reports.push({
      channel: channelId,
      accountId,
      accountName,
      configured,
      enabled,
      support: entry.capabilities,
      actions: entry.actions?.map((a) => String(a.id)),
    });
  }

  if (opts.json) {
    return JSON.stringify(reports, null, 2);
  }

  if (reports.length === 0) {
    return theme.warning("No channels configured.");
  }

  const lines = reports.map((report) =>
    formatChannelSummary({
      channel: report.channel,
      accountId: report.accountId,
      accountName: report.accountName,
      configured: !!report.configured,
      enabled: !!report.enabled,
      capabilities: report.support,
      actions: report.actions,
    }),
  );

  return lines.join("\n\n");
}
