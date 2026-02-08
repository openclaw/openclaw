import type { SlackEventMiddlewareArgs } from "@slack/bolt";
import type { AgentConfig } from "../../../config/types.agents.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { SlackHomeTabConfig } from "../../../config/types.slack.js";
import type { SlackMonitorContext } from "../context.js";
import { danger, logVerbose } from "../../../globals.js";
import { VERSION } from "../../../version.js";
import { hasCurrentHomeTab, hasCustomHomeTab, markHomeTabPublished } from "../../home-tab-state.js";

/** Gateway process start time — used for uptime display. */
const GATEWAY_START_MS = Date.now();

/**
 * Format a millisecond duration as a human-readable uptime string.
 * @internal Exported for testing only.
 */
export function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  parts.push(`${minutes}m`);
  return parts.join(" ");
}

/**
 * Resolve the primary model string for an agent, falling back to the
 * agents.defaults or top-level model config.
 * @internal Exported for testing only.
 */
export function resolveAgentModelDisplay(
  agent: AgentConfig | undefined,
  cfg: OpenClawConfig,
): string {
  // Per-agent model
  const agentModel = agent?.model;
  if (agentModel) {
    return typeof agentModel === "string" ? agentModel : (agentModel.primary ?? "—");
  }
  // Agent defaults model (always AgentModelListConfig, not a plain string)
  const defaultsModel = cfg.agents?.defaults?.model;
  if (defaultsModel?.primary) {
    return defaultsModel.primary;
  }
  return "—";
}

/**
 * Template variable context for Home Tab blocks.
 * Used to substitute `{{var_name}}` placeholders in custom block templates.
 */
export interface HomeTabTemplateVars {
  agent_name: string;
  version: string;
  model: string;
  uptime: string;
  channels: string;
  slash_command: string;
}

/**
 * Recursively substitute `{{var_name}}` template variables in Block Kit JSON.
 * @internal Exported for testing only.
 */
export function substituteTemplateVars(obj: unknown, vars: HomeTabTemplateVars): unknown {
  if (typeof obj === "string") {
    return obj.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
      const val = vars[key as keyof HomeTabTemplateVars];
      return val !== undefined ? val : match;
    });
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => substituteTemplateVars(item, vars));
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = substituteTemplateVars(value, vars);
    }
    return result;
  }
  return obj;
}

/**
 * Resolve template variables from the current config/runtime state.
 * @internal Exported for testing only.
 */
export function resolveTemplateVars(params: {
  cfg?: OpenClawConfig;
  slashCommand?: string;
  uptimeMs?: number;
}): HomeTabTemplateVars {
  const cfg = params.cfg;
  const agents = cfg?.agents?.list ?? [];
  const defaultAgent = agents.find((a) => a.default) ?? agents[0];
  const agentName = defaultAgent?.name ?? cfg?.ui?.assistant?.name ?? "OpenClaw";
  const model = resolveAgentModelDisplay(defaultAgent, cfg ?? {});
  const uptimeMs = params.uptimeMs ?? Date.now() - GATEWAY_START_MS;
  const cmd = params.slashCommand ?? "/openclaw";

  const slackCfg = cfg?.channels?.slack;
  const channelIds: string[] = [];
  if (slackCfg) {
    if (slackCfg.channels) {
      channelIds.push(...Object.keys(slackCfg.channels));
    }
    if (slackCfg.accounts) {
      for (const account of Object.values(slackCfg.accounts)) {
        if (account?.channels) {
          channelIds.push(...Object.keys(account.channels));
        }
      }
    }
  }

  return {
    agent_name: agentName,
    version: VERSION,
    model,
    uptime: formatUptime(uptimeMs),
    channels:
      channelIds.length > 0 ? channelIds.map((id) => `<#${id}>`).join(", ") : "None configured",
    slash_command: cmd,
  };
}

/** @internal Exported for testing only. */
export function buildHomeTabBlocks(params: {
  botUserId: string;
  slashCommand?: string;
  cfg?: OpenClawConfig;
  uptimeMs?: number;
  homeTabConfig?: SlackHomeTabConfig;
}): Record<string, unknown>[] {
  const cmd = params.slashCommand ?? "/openclaw";
  const cfg = params.cfg;

  // If custom blocks are configured, substitute template variables and return.
  if (params.homeTabConfig?.blocks && params.homeTabConfig.blocks.length > 0) {
    const vars = resolveTemplateVars({
      cfg,
      slashCommand: cmd,
      uptimeMs: params.uptimeMs,
    });
    return substituteTemplateVars(params.homeTabConfig.blocks, vars) as Record<string, unknown>[];
  }

  const blocks: Record<string, unknown>[] = [];

  // --- Header: Agent name & status ---
  const agents = cfg?.agents?.list ?? [];
  const defaultAgent = agents.find((a) => a.default) ?? agents[0];
  const agentName = defaultAgent?.name ?? cfg?.ui?.assistant?.name ?? "OpenClaw";

  blocks.push({
    type: "header",
    text: { type: "plain_text", text: agentName, emoji: true },
  });

  // --- Agent status + version ---
  const model = resolveAgentModelDisplay(defaultAgent, cfg ?? {});
  const statusFields: Record<string, unknown>[] = [
    { type: "mrkdwn", text: `*Status:*\n:large_green_circle: Online` },
    { type: "mrkdwn", text: `*Version:*\n\`${VERSION}\`` },
  ];

  blocks.push({ type: "section", fields: statusFields });

  // --- Model + Uptime ---
  const infoFields: Record<string, unknown>[] = [
    { type: "mrkdwn", text: `*Model:*\n\`${model}\`` },
  ];

  const uptimeMs = params.uptimeMs ?? Date.now() - GATEWAY_START_MS;
  infoFields.push({ type: "mrkdwn", text: `*Uptime:*\n${formatUptime(uptimeMs)}` });

  blocks.push({ type: "section", fields: infoFields });

  // --- Configured channels ---
  const slackCfg = cfg?.channels?.slack;
  const channelIds: string[] = [];
  if (slackCfg) {
    // Top-level channels (single-account or default account)
    if (slackCfg.channels) {
      channelIds.push(...Object.keys(slackCfg.channels));
    }
    // Multi-account channels
    if (slackCfg.accounts) {
      for (const account of Object.values(slackCfg.accounts)) {
        if (account?.channels) {
          channelIds.push(...Object.keys(account.channels));
        }
      }
    }
  }

  if (channelIds.length > 0) {
    const channelList = channelIds.map((id) => `<#${id}>`).join(", ");
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Channels:*\n${channelList}` },
    });
  }

  blocks.push({ type: "divider" });

  // --- Quick start ---
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: "*Getting Started*\nSend me a DM or mention me in a channel to start a conversation.",
    },
  });

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: [
        "*Slash Commands*",
        `• \`${cmd}\` — Main command`,
        `• \`${cmd} status\` — Check status`,
        `• \`${cmd} help\` — Show help`,
      ].join("\n"),
    },
  });

  blocks.push({ type: "divider" });

  // --- Footer: links ---
  const footerParts = [
    "<https://docs.openclaw.ai|Docs>",
    "<https://github.com/openclaw/openclaw|GitHub>",
    "<https://discord.com/invite/clawd|Community>",
  ];

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: footerParts.join(" · ") }],
  });

  return blocks;
}

export function registerSlackHomeTabEvents(params: { ctx: SlackMonitorContext }) {
  const { ctx } = params;

  // Resolve home tab config from Slack account config
  const homeTabConfig = ctx.cfg?.channels?.slack?.homeTab;

  // If explicitly disabled, don't register the event at all
  if (homeTabConfig?.enabled === false) {
    logVerbose("slack: home tab disabled via config");
    return;
  }

  ctx.app.event(
    "app_home_opened",
    async ({ event, body }: SlackEventMiddlewareArgs<"app_home_opened">) => {
      try {
        if (ctx.shouldDropMismatchedSlackEvent(body)) {
          return;
        }

        // Only handle the "home" tab (not "messages")
        if (event.tab !== "home") {
          return;
        }

        if (!ctx.botUserId) {
          logVerbose("slack: skipping home tab publish — botUserId not available");
          return;
        }

        const userId = event.user;

        // If the user has a custom (agent-pushed) view, don't overwrite it.
        if (hasCustomHomeTab(userId)) {
          logVerbose(`slack: home tab has custom view for ${userId}, skipping default publish`);
          return;
        }

        // Skip re-publish if this user already has the current version rendered
        if (hasCurrentHomeTab(userId, VERSION)) {
          logVerbose(`slack: home tab already published for ${userId}, skipping`);
          return;
        }

        const blocks = buildHomeTabBlocks({
          botUserId: ctx.botUserId,
          slashCommand: ctx.slashCommand.name ? `/${ctx.slashCommand.name}` : undefined,
          cfg: ctx.cfg,
          homeTabConfig,
        });

        await ctx.app.client.views.publish({
          token: ctx.botToken,
          user_id: userId,
          view: {
            type: "home",
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Block Kit JSON built dynamically
            blocks: blocks as any,
          },
        });

        markHomeTabPublished(userId, VERSION);
      } catch (err) {
        ctx.runtime.error?.(danger(`slack app_home_opened handler failed: ${String(err)}`));
      }
    },
  );
}
