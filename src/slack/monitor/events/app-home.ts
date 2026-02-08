import type { SlackMonitorContext } from "../context.js";
import { danger } from "../../../globals.js";
import { buildDefaultHomeView, type HomeTabParams } from "../../home-tab.js";

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

        const homeTabConfig = resolveHomeTabConfig(ctx);
        if (!homeTabConfig.enabled) {
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
        };

        const view = buildDefaultHomeView(viewParams);

        await ctx.app.client.views.publish({
          token: ctx.botToken,
          user_id: event.user as string,
          view,
        });
      } catch (err) {
        ctx.runtime.error?.(danger(`slack app_home_opened handler failed: ${String(err)}`));
      }
    },
  );
}
