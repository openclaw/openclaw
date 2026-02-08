import type { SlackMonitorContext } from "../context.js";
import { danger } from "../../../globals.js";
import { VERSION } from "../../../version.js";
import { hasCurrentHomeTab, hasCustomHomeTab, markHomeTabPublished } from "../../home-tab-state.js";
import { buildDefaultHomeView, type HomeTabParams } from "../../home-tab.js";

/** Gateway process start time — used for uptime display. */
const GATEWAY_START_MS = Date.now();

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
  const cfg = ctx.cfg;
  const slackCfg = cfg.channels?.slack as Record<string, unknown> | undefined;
  const slashCommand = slackCfg?.slashCommand as { enabled?: boolean; name?: string } | undefined;
  return {
    enabled: slashCommand?.enabled ?? false,
    name: slashCommand?.name?.trim() || "openclaw",
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

function resolveModel(ctx: SlackMonitorContext): string | undefined {
  const cfg = ctx.cfg;
  const agents = cfg.agents?.list ?? [];
  const defaultAgent = agents.find((a) => a.default) ?? agents[0];
  const model = defaultAgent?.model;
  if (model) {
    return typeof model === "string" ? model : (model.primary ?? undefined);
  }
  const defaultsModel = cfg.agents?.defaults?.model;
  if (defaultsModel?.primary) {
    return defaultsModel.primary;
  }
  return undefined;
}

function resolveChannelIds(ctx: SlackMonitorContext): string[] {
  const cfg = ctx.cfg;
  const slackCfg = cfg.channels?.slack as Record<string, unknown> | undefined;
  const channels = slackCfg?.channels as Record<string, unknown> | undefined;
  if (!channels) {
    return [];
  }
  return Object.keys(channels).filter((k) => k !== "*");
}

export function registerSlackAppHomeEvents(params: { ctx: SlackMonitorContext }) {
  const { ctx } = params;

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

        const userId = event.user as string;

        const homeTabConfig = resolveHomeTabConfig(ctx);
        if (!homeTabConfig.enabled) {
          return;
        }

        // Skip if user has a custom (agent-pushed) view
        if (hasCustomHomeTab(userId)) {
          return;
        }

        // Skip if we already published the current version for this user
        if (hasCurrentHomeTab(userId, VERSION)) {
          return;
        }

        const slashCmd = resolveSlashCommandInfo(ctx);
        const botName = resolveBotName(ctx);

        const viewParams: HomeTabParams = {
          botName,
          showCommands: homeTabConfig.showCommands,
          slashCommandName: slashCmd.name,
          slashCommandEnabled: slashCmd.enabled,
          customBlocks: homeTabConfig.customBlocks,
          version: VERSION,
          uptimeMs: Date.now() - GATEWAY_START_MS,
          model: resolveModel(ctx),
          channelIds: resolveChannelIds(ctx),
          botUserId: ctx.botUserId,
        };

        const view = buildDefaultHomeView(viewParams);

        await ctx.app.client.views.publish({
          token: ctx.botToken,
          user_id: userId,
          view,
        });

        markHomeTabPublished(userId, VERSION);
      } catch (err) {
        ctx.runtime.error?.(danger(`slack app_home_opened handler failed: ${String(err)}`));
      }
    },
  );
}
