import type { View } from "@slack/web-api";

export type HomeTabParams = {
  /** Agent/bot display name. */
  botName?: string;
  /** Whether to show available commands section. */
  showCommands?: boolean;
  /** Slash command name (e.g. "openclaw"). */
  slashCommandName?: string;
  /** Whether slash command is enabled. */
  slashCommandEnabled?: boolean;
  /** Optional static Block Kit blocks to append. */
  customBlocks?: unknown[];
};

/**
 * Build the default Home tab view for the OpenClaw Slack app.
 * Returns a Slack Block Kit view with `type: "home"`.
 */
export function buildDefaultHomeView(params: HomeTabParams = {}): View {
  const botName = params.botName?.trim() || "OpenClaw";
  const showCommands = params.showCommands ?? true;
  const slashCommandName = params.slashCommandName?.trim() || "openclaw";
  const slashCommandEnabled = params.slashCommandEnabled ?? false;

  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `🦞 ${botName}`,
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Hey! I'm *${botName}*, your AI assistant. Send me a DM to get started.`,
      },
    },
    { type: "divider" },
  ];

  if (showCommands) {
    const commandLines: string[] = ["*How to interact:*", "• Send me a direct message to chat"];

    if (slashCommandEnabled) {
      commandLines.push(`• Use \`/${slashCommandName}\` in any channel`);
    }

    commandLines.push("• Mention me in a channel to get my attention");

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: commandLines.join("\n"),
      },
    });

    blocks.push({ type: "divider" });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Powered by <https://openclaw.ai|OpenClaw>`,
      },
    ],
  });

  if (Array.isArray(params.customBlocks) && params.customBlocks.length > 0) {
    blocks.push({ type: "divider" });
    blocks.push(...params.customBlocks);
  }

  return {
    type: "home",
    blocks,
  } as View;
}
