import type { ChannelCapabilities, ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import { getChannelPlugin, listChannelPlugins } from "../../channels/plugins/index.js";
import { danger } from "../../globals.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { fetchSlackScopes, type SlackScopesResult } from "../../slack/scopes.js";
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
  probe?: unknown;
  slackScopes?: Array<{
    tokenType: "bot" | "user";
    result: SlackScopesResult;
  }>;
};

function normalizeTimeout(raw: unknown, fallback = 10_000) {
  const value = typeof raw === "string" ? Number(raw) : Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function formatSupport(capabilities?: ChannelCapabilities) {
  if (!capabilities) {
    return "unknown";
  }
  const bits: string[] = [];
  if (capabilities.chatTypes?.length) {
    bits.push(`chatTypes=${capabilities.chatTypes.join(",")}`);
  }
  if (capabilities.polls) {
    bits.push("polls");
  }
  if (capabilities.reactions) {
    bits.push("reactions");
  }
  if (capabilities.edit) {
    bits.push("edit");
  }
  if (capabilities.unsend) {
    bits.push("unsend");
  }
  if (capabilities.reply) {
    bits.push("reply");
  }
  if (capabilities.effects) {
    bits.push("effects");
  }
  if (capabilities.groupManagement) {
    bits.push("groupManagement");
  }
  if (capabilities.threads) {
    bits.push("threads");
  }
  if (capabilities.media) {
    bits.push("media");
  }
  if (capabilities.nativeCommands) {
    bits.push("nativeCommands");
  }
  if (capabilities.blockStreaming) {
    bits.push("blockStreaming");
  }
  return bits.length ? bits.join(" ") : "none";
}

function formatProbeLines(channelId: string, probe: unknown): string[] {
  const lines: string[] = [];
  if (!probe || typeof probe !== "object") {
    return lines;
  }
  const probeObj = probe as Record<string, unknown>;

  if (channelId === "telegram") {
    const bot = probeObj.bot as { username?: string | null; id?: number | null } | undefined;
    if (bot?.username) {
      const botId = bot.id ? ` (${bot.id})` : "";
      lines.push(`Bot: ${theme.accent(`@${bot.username}`)}${botId}`);
    }
    const flags: string[] = [];
    const canJoinGroups = (bot as { canJoinGroups?: boolean | null })?.canJoinGroups;
    const canReadAll = (bot as { canReadAllGroupMessages?: boolean | null })
      ?.canReadAllGroupMessages;
    const inlineQueries = (bot as { supportsInlineQueries?: boolean | null })
      ?.supportsInlineQueries;
    if (typeof canJoinGroups === "boolean") {
      flags.push(`joinGroups=${canJoinGroups}`);
    }
    if (typeof canReadAll === "boolean") {
      flags.push(`readAllGroupMessages=${canReadAll}`);
    }
    if (typeof inlineQueries === "boolean") {
      flags.push(`inlineQueries=${inlineQueries}`);
    }
    if (flags.length > 0) {
      lines.push(`Flags: ${flags.join(" ")}`);
    }
    const webhook = probeObj.webhook as { url?: string | null } | undefined;
    if (webhook?.url !== undefined) {
      lines.push(`Webhook: ${webhook.url || "none"}`);
    }
  }

  if (channelId === "slack") {
    const bot = probeObj.bot as { name?: string } | undefined;
    const team = probeObj.team as { name?: string; id?: string } | undefined;
    if (bot?.name) {
      lines.push(`Bot: ${theme.accent(`@${bot.name}`)}`);
    }
    if (team?.name || team?.id) {
      const id = team?.id ? ` (${team.id})` : "";
      lines.push(`Team: ${team?.name ?? "unknown"}${id}`);
    }
  }

  const ok = typeof probeObj.ok === "boolean" ? probeObj.ok : undefined;
  if (ok === true && lines.length === 0) {
    lines.push("Probe: ok");
  }
  if (ok === false) {
    const error =
      typeof probeObj.error === "string" && probeObj.error ? ` (${probeObj.error})` : "";
    lines.push(`Probe: ${theme.error(`failed${error}`)}`);
  }
  return lines;
}

async function resolveChannelReports(params: {
  plugin: ChannelPlugin;
  cfg: OpenClawConfig;
  timeoutMs: number;
  accountOverride?: string;
  target?: string;
}): Promise<ChannelCapabilitiesReport[]> {
  const { plugin, cfg, timeoutMs } = params;
  const accountIds = params.accountOverride
    ? [params.accountOverride]
    : (() => {
        const ids = plugin.config.listAccountIds(cfg);
        return ids.length > 0
          ? ids
          : [resolveChannelDefaultAccountId({ plugin, cfg, accountIds: ids })];
      })();
  const reports: ChannelCapabilitiesReport[] = [];
  const listedActions = plugin.actions?.listActions?.({ cfg }) ?? [];
  const actions = Array.from(
    new Set<string>(["send", "broadcast", ...listedActions.map((action) => String(action))]),
  );

  for (const accountId of accountIds) {
    const resolvedAccount = plugin.config.resolveAccount(cfg, accountId);
    const configured = plugin.config.isConfigured
      ? await plugin.config.isConfigured(resolvedAccount, cfg)
      : Boolean(resolvedAccount);
    const enabled = plugin.config.isEnabled
      ? plugin.config.isEnabled(resolvedAccount, cfg)
      : (resolvedAccount as { enabled?: boolean }).enabled !== false;
    let probe: unknown;
    if (configured && enabled && plugin.status?.probeAccount) {
      try {
        probe = await plugin.status.probeAccount({
          account: resolvedAccount,
          timeoutMs,
          cfg,
        });
      } catch (err) {
        probe = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    let slackScopes: ChannelCapabilitiesReport["slackScopes"];
    if (plugin.id === "slack" && configured && enabled) {
      const botToken = (resolvedAccount as { botToken?: string }).botToken?.trim();
      const userToken = (
        resolvedAccount as { config?: { userToken?: string } }
      ).config?.userToken?.trim();
      const scopeReports: NonNullable<ChannelCapabilitiesReport["slackScopes"]> = [];
      if (botToken) {
        scopeReports.push({
          tokenType: "bot",
          result: await fetchSlackScopes(botToken, timeoutMs),
        });
      } else {
        scopeReports.push({
          tokenType: "bot",
          result: { ok: false, error: "Slack bot token missing." },
        });
      }
      if (userToken) {
        scopeReports.push({
          tokenType: "user",
          result: await fetchSlackScopes(userToken, timeoutMs),
        });
      }
      slackScopes = scopeReports;
    }

    reports.push({
      channel: plugin.id,
      accountId,
      accountName:
        typeof (resolvedAccount as { name?: string }).name === "string"
          ? (resolvedAccount as { name?: string }).name?.trim() || undefined
          : undefined,
      configured,
      enabled,
      support: plugin.capabilities,
      probe,
      actions,
      slackScopes,
    });
  }
  return reports;
}

export async function channelsCapabilitiesCommand(
  opts: ChannelsCapabilitiesOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) {
    return;
  }
  const timeoutMs = normalizeTimeout(opts.timeout, 10_000);
  const rawChannel = typeof opts.channel === "string" ? opts.channel.trim().toLowerCase() : "";
  const _rawTarget = typeof opts.target === "string" ? opts.target.trim() : "";

  if (opts.account && (!rawChannel || rawChannel === "all")) {
    runtime.error(danger("--account requires a specific --channel."));
    runtime.exit(1);
    return;
  }

  const plugins = listChannelPlugins();
  const selected =
    !rawChannel || rawChannel === "all"
      ? plugins
      : (() => {
          const plugin = getChannelPlugin(rawChannel);
          if (!plugin) {
            return null;
          }
          return [plugin];
        })();

  if (!selected || selected.length === 0) {
    runtime.error(danger(`Unknown channel "${rawChannel}".`));
    runtime.exit(1);
    return;
  }

  const reports: ChannelCapabilitiesReport[] = [];
  for (const plugin of selected) {
    const accountOverride = opts.account?.trim() || undefined;
    reports.push(
      ...(await resolveChannelReports({
        plugin,
        cfg,
        timeoutMs,
        accountOverride,
      })),
    );
  }

  if (opts.json) {
    runtime.log(JSON.stringify({ channels: reports }, null, 2));
    return;
  }

  const lines: string[] = [];
  for (const report of reports) {
    const label = formatChannelAccountLabel({
      channel: report.channel,
      accountId: report.accountId,
      name: report.accountName,
      channelStyle: theme.accent,
      accountStyle: theme.heading,
    });
    lines.push(theme.heading(label));
    lines.push(`Support: ${formatSupport(report.support)}`);
    if (report.actions && report.actions.length > 0) {
      lines.push(`Actions: ${report.actions.join(", ")}`);
    }
    if (report.configured === false || report.enabled === false) {
      const configuredLabel = report.configured === false ? "not configured" : "configured";
      const enabledLabel = report.enabled === false ? "disabled" : "enabled";
      lines.push(`Status: ${configuredLabel}, ${enabledLabel}`);
    }
    const probeLines = formatProbeLines(report.channel, report.probe);
    if (probeLines.length > 0) {
      lines.push(...probeLines);
    } else if (report.configured && report.enabled) {
      lines.push(theme.muted("Probe: unavailable"));
    }
    if (report.channel === "slack" && report.slackScopes) {
      for (const entry of report.slackScopes) {
        const source = entry.result.source ? ` (${entry.result.source})` : "";
        const label = entry.tokenType === "user" ? "User scopes" : "Bot scopes";
        if (entry.result.ok && entry.result.scopes?.length) {
          lines.push(`${label}${source}: ${entry.result.scopes.join(", ")}`);
        } else if (entry.result.error) {
          lines.push(`${label}: ${theme.error(entry.result.error)}`);
        }
      }
    }
    lines.push("");
  }

  runtime.log(lines.join("\n").trimEnd());
}
