import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { listChatChannels } from "../../channels/chat-meta.js";
import { isChannelVisibleInConfiguredLists } from "../../channels/plugins/exposure.js";
import { listReadOnlyChannelPluginsForConfig } from "../../channels/plugins/read-only.js";
import { buildChannelAccountSnapshot } from "../../channels/plugins/status.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import { isStaticallyChannelConfigured } from "../../config/channel-configured-shared.js";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { listTrustedChannelPluginCatalogEntries } from "../channel-setup/trusted-catalog.js";
import { formatChannelAccountLabel, requireValidConfig } from "./shared.js";

export type ChannelsListOptions = {
  json?: boolean;
  usage?: boolean;
};

const colorValue = (value: string) => {
  if (value === "none") {
    return theme.error(value);
  }
  if (value === "env") {
    return theme.accent(value);
  }
  return theme.success(value);
};

function formatEnabled(value: boolean | undefined): string {
  return value === false ? theme.error("disabled") : theme.success("enabled");
}

function formatConfigured(value: boolean): string {
  return value ? theme.success("configured") : theme.warn("not configured");
}

function formatTokenSource(source?: string): string {
  const value = source || "none";
  return `token=${colorValue(value)}`;
}

function formatSource(label: string, source?: string): string {
  const value = source || "none";
  return `${label}=${colorValue(value)}`;
}

function formatLinked(value: boolean): string {
  return value ? theme.success("linked") : theme.warn("not linked");
}

function shouldShowConfigured(channel: ChannelPlugin): boolean {
  return isChannelVisibleInConfiguredLists(channel.meta);
}

function formatAccountLine(params: {
  channel: ChannelPlugin;
  snapshot: ChannelAccountSnapshot;
}): string {
  const { channel, snapshot } = params;
  const label = formatChannelAccountLabel({
    channel: channel.id,
    accountId: snapshot.accountId,
    name: snapshot.name,
    channelLabel: channel.meta.label ?? channel.id,
    channelStyle: theme.accent,
    accountStyle: theme.heading,
  });
  const bits: string[] = [];
  if (snapshot.linked !== undefined) {
    bits.push(formatLinked(snapshot.linked));
  }
  if (shouldShowConfigured(channel) && typeof snapshot.configured === "boolean") {
    bits.push(formatConfigured(snapshot.configured));
  }
  if (snapshot.tokenSource) {
    bits.push(formatTokenSource(snapshot.tokenSource));
  }
  if (snapshot.botTokenSource) {
    bits.push(formatSource("bot", snapshot.botTokenSource));
  }
  if (snapshot.appTokenSource) {
    bits.push(formatSource("app", snapshot.appTokenSource));
  }
  if (snapshot.baseUrl) {
    bits.push(`base=${theme.muted(snapshot.baseUrl)}`);
  }
  if (typeof snapshot.enabled === "boolean") {
    bits.push(formatEnabled(snapshot.enabled));
  }
  return `- ${label}: ${bits.join(", ")}`;
}
type ChannelListEntry = {
  id: string;
  label: string;
  order: number;
  configured: boolean;
  enabled: boolean;
  installed: boolean;
  accounts: string[];
  source: "bundled" | "catalog" | "configured";
};

const NON_CHANNEL_CONFIG_KEYS = new Set(["defaults"]);

function resolveChannelEnabled(cfg: Record<string, unknown>, channelId: string): boolean {
  const channels = cfg.channels;
  if (channels && typeof channels === "object" && !Array.isArray(channels)) {
    const channelConfig = (channels as Record<string, unknown>)[channelId];
    if (channelConfig && typeof channelConfig === "object" && !Array.isArray(channelConfig)) {
      if ((channelConfig as Record<string, unknown>).enabled === false) {
        return false;
      }
    }
  }
  return true;
}

function formatInstalled(value: boolean): string {
  return value ? theme.success("installed") : theme.warn("not installed");
}

function formatChannelSummaryLine(entry: ChannelListEntry): string {
  const bits = [
    formatConfigured(entry.configured),
    formatEnabled(entry.enabled),
    formatInstalled(entry.installed),
  ];
  return `- ${theme.accent(entry.label)}: ${bits.join(", ")}`;
}

function configuredChannelIdsFromConfig(cfg: Record<string, unknown>): string[] {
  const channels = cfg.channels;
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
    return [];
  }
  return Object.keys(channels).filter((id) => !NON_CHANNEL_CONFIG_KEYS.has(id));
}

export async function channelsListCommand(
  opts: ChannelsListOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) {
    return;
  }
  void opts.usage;

  const plugins = listReadOnlyChannelPluginsForConfig(cfg, {
    includeSetupFallbackPlugins: true,
  });
  const pluginById = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
  const catalogEntries = listTrustedChannelPluginCatalogEntries({ cfg, workspaceDir });
  const entries = new Map<string, ChannelListEntry>();

  const upsert = (entry: ChannelListEntry) => {
    const existing = entries.get(entry.id);
    entries.set(entry.id, {
      ...entry,
      ...existing,
      configured: Boolean(existing?.configured || entry.configured),
      enabled: existing?.enabled === false || entry.enabled === false ? false : true,
      installed: Boolean(existing?.installed || entry.installed),
      accounts: existing?.accounts.length ? existing.accounts : entry.accounts,
      source: existing?.source ?? entry.source,
    });
  };

  for (const meta of listChatChannels()) {
    const plugin = pluginById.get(meta.id);
    upsert({
      id: meta.id,
      label: meta.label ?? meta.id,
      order: meta.order ?? Number.MAX_SAFE_INTEGER,
      configured: isStaticallyChannelConfigured(cfg, meta.id),
      enabled: resolveChannelEnabled(cfg, meta.id),
      installed: Boolean(plugin),
      accounts: plugin?.config.listAccountIds(cfg) ?? [],
      source: "bundled",
    });
  }

  for (const plugin of plugins) {
    const accounts = plugin.config.listAccountIds(cfg);
    upsert({
      id: plugin.id,
      label: plugin.meta.label ?? plugin.id,
      order: plugin.meta.order ?? Number.MAX_SAFE_INTEGER,
      configured: accounts.length > 0 || isStaticallyChannelConfigured(cfg, plugin.id),
      enabled: resolveChannelEnabled(cfg, plugin.id),
      installed: true,
      accounts,
      source: "bundled",
    });
  }

  for (const entry of catalogEntries) {
    const plugin = pluginById.get(entry.id);
    const accounts = plugin?.config.listAccountIds(cfg) ?? [];
    upsert({
      id: entry.id,
      label: entry.meta.label ?? entry.id,
      order: entry.meta.order ?? Number.MAX_SAFE_INTEGER,
      configured: accounts.length > 0 || isStaticallyChannelConfigured(cfg, entry.id),
      enabled: resolveChannelEnabled(cfg, entry.id),
      installed: Boolean(plugin),
      accounts,
      source: "catalog",
    });
  }

  for (const channelId of configuredChannelIdsFromConfig(cfg)) {
    const plugin = pluginById.get(channelId);
    const accounts = plugin?.config.listAccountIds(cfg) ?? [];
    upsert({
      id: channelId,
      label: plugin?.meta.label ?? channelId,
      order: plugin?.meta.order ?? Number.MAX_SAFE_INTEGER,
      configured: accounts.length > 0 || isStaticallyChannelConfigured(cfg, channelId),
      enabled: resolveChannelEnabled(cfg, channelId),
      installed: Boolean(plugin),
      accounts,
      source: "configured",
    });
  }

  const channels = [...entries.values()].toSorted((left, right) => {
    if (left.order !== right.order) {
      return left.order - right.order;
    }
    return left.label.localeCompare(right.label);
  });

  if (opts.json) {
    writeRuntimeJson(runtime, { channels });
    return;
  }

  const lines: string[] = [];
  lines.push(theme.heading("Chat channels:"));

  if (channels.length === 0) {
    lines.push(theme.muted("- none"));
  }

  for (const entry of channels) {
    const plugin = pluginById.get(entry.id);
    lines.push(formatChannelSummaryLine(entry));
    if (!plugin || entry.accounts.length === 0) {
      continue;
    }
    for (const accountId of entry.accounts) {
      const snapshot = await buildChannelAccountSnapshot({
        plugin,
        cfg,
        accountId,
      });
      lines.push(
        `  ${formatAccountLine({
          channel: plugin,
          snapshot,
        }).slice(2)}`,
      );
    }
  }

  runtime.log(lines.join("\n"));

  runtime.log("");
  runtime.log(`Docs: ${formatDocsLink("/channels", "channels")}`);
}
