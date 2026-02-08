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
  /** OpenClaw version string. */
  version?: string;
  /** Gateway uptime in milliseconds. */
  uptimeMs?: number;
  /** Model display string. */
  model?: string;
  /** Configured channel IDs to display. */
  channelIds?: string[];
  /** Bot user ID for mention formatting. */
  botUserId?: string;
  /** Owner's IANA timezone (e.g. "America/Los_Angeles"). Defaults to UTC. */
  ownerTimezone?: string;
};

/**
 * Format a millisecond duration as a human-readable uptime string.
 * @internal Exported for testing.
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
  ];

  // Status + version fields
  const statusFields: unknown[] = [
    { type: "mrkdwn", text: "*Status:*\n🟢 Online" },
    { type: "mrkdwn", text: `*Version:*\n${params.version || "—"}` },
  ];
  if (params.model) {
    statusFields.push({ type: "mrkdwn", text: `*Model:*\n${params.model}` });
  }
  if (params.uptimeMs != null) {
    const startedAt = new Date(Date.now() - params.uptimeMs);
    const tz = params.ownerTimezone || "UTC";
    let startedStr: string;
    try {
      startedStr = startedAt.toLocaleString("en-US", {
        timeZone: tz,
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      });
    } catch {
      startedStr = startedAt.toISOString().replace("T", " ").slice(0, 19) + " UTC";
    }
    const tzShort = tz === "UTC" ? "UTC" : tz.split("/").pop()?.replace(/_/g, " ") || tz;
    statusFields.push({
      type: "mrkdwn",
      text: `*Uptime:*\n${formatUptime(params.uptimeMs)}\n_since ${startedStr} ${tzShort}_`,
    });
  }
  blocks.push({ type: "section", fields: statusFields });

  blocks.push({ type: "divider" });

  // Getting started section
  const introLines = [
    `*Getting Started*`,
    `• Send me a direct message to chat`,
    `• Mention <@${params.botUserId || "me"}> in a channel`,
  ];
  if (slashCommandEnabled) {
    introLines.push(`• Use \`/${slashCommandName}\` in any channel`);
  }
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: introLines.join("\n") },
  });

  // Configured channels
  if (params.channelIds && params.channelIds.length > 0) {
    const channelMentions = params.channelIds.map((id) => `<#${id}>`).join(", ");
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Channels:*\n${channelMentions}` },
    });
  }

  if (showCommands && slashCommandEnabled) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*Slash Commands*`,
          `\`/${slashCommandName}\` — Send a message`,
          `\`/${slashCommandName} help\` — Show help`,
        ].join("\n"),
      },
    });
  }

  blocks.push({ type: "divider" });

  // Links footer
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: [
          `Powered by <https://openclaw.ai|OpenClaw>`,
          `<https://docs.openclaw.ai|Docs>`,
          `<https://github.com/openclaw/openclaw|GitHub>`,
          `<https://discord.com/invite/clawd|Community>`,
        ].join(" · "),
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
