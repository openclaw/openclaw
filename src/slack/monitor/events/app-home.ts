import type { AgentConfig } from "../../../config/types.agents.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { SlackMonitorContext } from "../context.js";
import { resolveUserTimezone } from "../../../agents/date-time.js";
import { danger, logVerbose } from "../../../globals.js";
import { VERSION } from "../../../version.js";
import {
  clearPublishInFlight,
  hasCurrentHomeTab,
  hasCustomHomeTab,
  isPublishInFlight,
  markHomeTabPublished,
  markPublishInFlight,
} from "../../home-tab-state.js";
import { buildDefaultHomeView, type HomeTabParams } from "../../home-tab.js";

/** Returns process uptime in milliseconds, consistent with gateway health state. */
function processUptimeMs(): number {
  return Math.round(process.uptime() * 1000);
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
  const agentModel = agent?.model;
  if (agentModel) {
    return typeof agentModel === "string" ? agentModel : (agentModel.primary ?? "—");
  }
  const defaultsModel = cfg.agents?.defaults?.model;
  if (defaultsModel?.primary) {
    return defaultsModel.primary;
  }
  return "—";
}

export type AppHomeConfig = {
  enabled?: boolean;
  showCommands?: boolean;
  customBlocks?: unknown[];
};

function resolveHomeTabConfig(ctx: SlackMonitorContext): AppHomeConfig {
  const cfg = ctx.cfg;
  const slackCfg = cfg.channels?.slack as Record<string, unknown> | undefined;
  const homeTab = slackCfg?.homeTab as AppHomeConfig | undefined;
  return {
    enabled: homeTab?.enabled ?? true,
    showCommands: homeTab?.showCommands ?? true,
    customBlocks: homeTab?.customBlocks,
  };
}

function resolveSlashCommandInfo(ctx: SlackMonitorContext): {
  enabled: boolean;
  name: string;
} {
  return {
    enabled: ctx.slashCommand.enabled,
    name: ctx.slashCommand.name?.trim() || "openclaw",
  };
}

function resolveBotName(ctx: SlackMonitorContext): string {
  const cfg = ctx.cfg;
  const slackCfg = cfg.channels?.slack as Record<string, unknown> | undefined;
  return (
    (typeof slackCfg?.name === "string" ? slackCfg.name.trim() : "") ||
    (typeof cfg.ui?.assistant?.name === "string" ? cfg.ui.assistant.name.trim() : "") ||
    "OpenClaw"
  );
}

function resolveChannelIds(ctx: SlackMonitorContext): string[] {
  const cfg = ctx.cfg;
  const slackCfg = cfg.channels?.slack;
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

  return channelIds.filter((k) => k !== "*");
}

export function registerSlackAppHomeEvents(params: { ctx: SlackMonitorContext }) {
  const { ctx } = params;

  // If explicitly disabled, don't register the event at all
  const homeTabConfig = resolveHomeTabConfig(ctx);
  if (homeTabConfig.enabled === false) {
    logVerbose("slack: home tab disabled via config");
    return;
  }

  const accountId = ctx.accountId;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ctx.app as any).event(
    "app_home_opened",
    async (args: { event: Record<string, unknown>; body: unknown }) => {
      const { event, body } = args;
      try {
        if (ctx.shouldDropMismatchedSlackEvent(body)) {
          return;
        }

        // Only handle the "home" tab, not "messages"
        if (event.tab !== "home") {
          return;
        }

        if (!ctx.botUserId) {
          logVerbose("slack: skipping home tab publish — botUserId not available");
          return;
        }

        const userId = event.user as string;

        // If the user has a custom (agent-pushed) view, don't overwrite it.
        if (hasCustomHomeTab(accountId, userId)) {
          logVerbose(`slack: home tab has custom view for ${userId}, skipping default publish`);
          return;
        }

        // Skip re-publish if this user already has the current version rendered
        if (hasCurrentHomeTab(accountId, userId, VERSION)) {
          logVerbose(`slack: home tab already published for ${userId}, skipping`);
          return;
        }

        // Deduplicate concurrent app_home_opened events for the same user
        if (isPublishInFlight(accountId, userId)) {
          logVerbose(`slack: home tab publish already in-flight for ${userId}, skipping`);
          return;
        }
        markPublishInFlight(accountId, userId);

        try {
          const slashCmd = resolveSlashCommandInfo(ctx);
          const botName = resolveBotName(ctx);
          const model = resolveAgentModelDisplay(
            (ctx.cfg.agents?.list ?? []).find((a) => a.default) ?? ctx.cfg.agents?.list?.[0],
            ctx.cfg,
          );

          const viewParams: HomeTabParams = {
            botName,
            showCommands: homeTabConfig.showCommands,
            slashCommandName: slashCmd.name,
            slashCommandEnabled: slashCmd.enabled,
            customBlocks: homeTabConfig.customBlocks,
            version: VERSION,
            uptimeMs: processUptimeMs(),
            model,
            channelIds: resolveChannelIds(ctx),
            botUserId: ctx.botUserId,
            ownerTimezone: resolveUserTimezone(ctx.cfg.agents?.defaults?.userTimezone),
          };

          const view = buildDefaultHomeView(viewParams);

          await ctx.app.client.views.publish({
            token: ctx.botToken,
            user_id: userId,
            view,
          });

          markHomeTabPublished(accountId, userId, VERSION);
        } finally {
          clearPublishInFlight(accountId, userId);
        }
      } catch (err) {
        ctx.runtime.error?.(danger(`slack app_home_opened handler failed: ${String(err)}`));
      }
    },
  );
}
