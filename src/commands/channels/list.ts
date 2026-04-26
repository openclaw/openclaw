import { loadAuthProfileStoreWithoutExternalProfiles } from "../../agents/auth-profiles.js";
import { isChannelVisibleInConfiguredLists } from "../../channels/plugins/exposure.js";
import { listReadOnlyChannelPluginsForConfig } from "../../channels/plugins/read-only.js";
import { buildChannelAccountSnapshot } from "../../channels/plugins/status.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import { withProgress } from "../../cli/progress.js";
import { formatUsageReportLines, loadProviderUsageSummary } from "../../infra/provider-usage.js";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { describeUnknownError } from "../../secrets/shared.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { formatChannelAccountLabel, requireValidConfig } from "./shared.js";

export type ChannelsListOptions = {
  json?: boolean;
  usage?: boolean;
};

function classifyUsageSnapshotFailure(error: unknown): {
  lines: string[];
  rawError?: string;
} {
  const message = describeUnknownError(error).trim();
  const normalized = message.toLowerCase();
  const isClaudeScopeFailure =
    normalized.includes("claude") &&
    (normalized.includes("403") || normalized.includes("user:profile"));

  if (isClaudeScopeFailure) {
    return {
      lines: [
        "Usage snapshot unavailable for Claude.",
        "This usually means the current auth does not have the required user:profile access.",
        "Try openclaw channels list --no-usage, re-auth via Claude Code CLI, or set CLAUDE_WEB_SESSION_KEY / CLAUDE_WEB_COOKIE.",
      ],
    };
  }

  return {
    lines: [
      "Usage snapshot unavailable.",
      "The channel and auth summary above is still valid.",
      "Try openclaw channels list --no-usage, re-auth the affected provider, or retry with the required credentials in this command path.",
    ],
    rawError: message || undefined,
  };
}

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
async function loadUsageWithProgress(
  runtime: RuntimeEnv,
): Promise<Awaited<ReturnType<typeof loadProviderUsageSummary>> | null> {
  try {
    return await withProgress(
      { label: "Fetching usage snapshot…", indeterminate: true, enabled: true },
      async () => await loadProviderUsageSummary({ skipPluginAuthWithoutCredentialSource: true }),
    );
  } catch (err) {
    const classified = classifyUsageSnapshotFailure(err);
    runtime.log("");
    runtime.log(theme.warn("Usage:"));
    for (const line of classified.lines) {
      runtime.log(theme.warn(`- ${line}`));
    }
    if (classified.rawError) {
      runtime.log(theme.muted(`  Error: ${classified.rawError}`));
    }
    return null;
  }
}

export async function channelsListCommand(
  opts: ChannelsListOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) {
    return;
  }
  const includeUsage = opts.usage !== false;

  const plugins = listReadOnlyChannelPluginsForConfig(cfg, {
    includeSetupRuntimeFallback: false,
  });

  const authStore = loadAuthProfileStoreWithoutExternalProfiles();
  const authProfiles = Object.entries(authStore.profiles).map(([profileId, profile]) => ({
    id: profileId,
    provider: profile.provider,
    type: profile.type,
    isExternal: false,
  }));
  if (opts.json) {
    const usage = includeUsage
      ? await loadProviderUsageSummary({ skipPluginAuthWithoutCredentialSource: true })
      : undefined;
    const chat: Record<string, string[]> = {};
    for (const plugin of plugins) {
      chat[plugin.id] = plugin.config.listAccountIds(cfg);
    }
    const payload = { chat, auth: authProfiles, ...(usage ? { usage } : {}) };
    writeRuntimeJson(runtime, payload);
    return;
  }

  const lines: string[] = [];
  lines.push(theme.heading("Chat channels:"));

  for (const plugin of plugins) {
    const accounts = plugin.config.listAccountIds(cfg);
    if (!accounts || accounts.length === 0) {
      continue;
    }
    for (const accountId of accounts) {
      const snapshot = await buildChannelAccountSnapshot({
        plugin,
        cfg,
        accountId,
      });
      lines.push(
        formatAccountLine({
          channel: plugin,
          snapshot,
        }),
      );
    }
  }

  lines.push("");
  lines.push(theme.heading("Auth providers (OAuth + API keys):"));
  if (authProfiles.length === 0) {
    lines.push(theme.muted("- none"));
  } else {
    for (const profile of authProfiles) {
      const external = profile.isExternal ? theme.muted(" (synced)") : "";
      lines.push(`- ${theme.accent(profile.id)} (${theme.success(profile.type)}${external})`);
    }
  }

  runtime.log(lines.join("\n"));

  if (includeUsage) {
    runtime.log("");
    const usage = await loadUsageWithProgress(runtime);
    if (usage) {
      const usageLines = formatUsageReportLines(usage);
      if (usageLines.length > 0) {
        usageLines[0] = theme.accent(usageLines[0]);
        runtime.log(usageLines.join("\n"));
      }
    }
  }

  runtime.log("");
  runtime.log(`Docs: ${formatDocsLink("/gateway/configuration", "gateway/configuration")}`);
}
