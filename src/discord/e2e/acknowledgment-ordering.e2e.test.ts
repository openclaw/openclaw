import { ChannelType, Client, Events, GatewayIntentBits } from "discord.js";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "../../infra/env.js";

// Gated behind LIVE=1 — these tests hit real Discord.
const LIVE = isTruthyEnvValue(process.env.LIVE) || isTruthyEnvValue(process.env.CLAWDBOT_LIVE_TEST);
const describeLive = LIVE ? describe : describe.skip;

// The Claw bot's Discord user ID.
const CLAW_BOT_ID = process.env.DISCORD_E2E_CLAW_BOT_ID ?? "1468764779471700133";
// Guild where the E2E tester bot can create channels.
const GUILD_ID = process.env.DISCORD_E2E_GUILD_ID ?? "1471323114418733261";

function resolveTestBotToken(): string {
  if (process.env.DISCORD_E2E_BOT_TOKEN) {
    return process.env.DISCORD_E2E_BOT_TOKEN;
  }
  const keyPath = path.join(os.homedir(), ".keys", "discord-e2e-bot-token");
  try {
    return fs.readFileSync(keyPath, "utf-8").trim();
  } catch {
    throw new Error(
      `Discord E2E bot token not found. Set DISCORD_E2E_BOT_TOKEN or ` +
        `create ${keyPath} with the token.`,
    );
  }
}

type MessageEvent = {
  type: "create" | "update" | "delete";
  messageId: string;
  content?: string;
  timestamp: number;
};

describeLive("Discord acknowledgment ordering", () => {
  let client: Client;
  let channelId: string;
  let events: MessageEvent[];
  const nonce = randomBytes(4).toString("hex");
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const channelName = `e2e-ack-${today}-${nonce}`;

  beforeAll(async () => {
    const token = resolveTestBotToken();
    events = [];

    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    await client.login(token);

    await new Promise<void>((resolve) => {
      if (client.isReady()) {
        resolve();
      } else {
        client.once(Events.ClientReady, () => resolve());
      }
    });

    // Create ephemeral test channel.
    const guild = await client.guilds.fetch(GUILD_ID);
    const channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      topic: `E2E acknowledgment ordering test (auto-created, safe to delete)`,
    });
    channelId = channel.id;

    // Track messages from the Claw bot in the new channel.
    client.on(Events.MessageCreate, (msg) => {
      if (msg.author.id === CLAW_BOT_ID && msg.channelId === channelId) {
        events.push({
          type: "create",
          messageId: msg.id,
          content: msg.content,
          timestamp: Date.now(),
        });
      }
    });

    client.on(Events.MessageUpdate, (_oldMsg, newMsg) => {
      if (newMsg.author?.id === CLAW_BOT_ID && newMsg.channelId === channelId) {
        events.push({
          type: "update",
          messageId: newMsg.id,
          content: newMsg.content ?? undefined,
          timestamp: Date.now(),
        });
      }
    });
  }, 30000);

  afterAll(async () => {
    // Prune E2E channels older than 7 days.
    if (client) {
      try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const channels = await guild.channels.fetch();
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        for (const [, ch] of channels) {
          if (!ch) {
            continue;
          }
          const match = ch.name.match(/^e2e-ack-(\d{4}-\d{2}-\d{2})-/);
          if (!match) {
            continue;
          }
          const channelDate = new Date(match[1]).getTime();
          if (Number.isNaN(channelDate) || channelDate >= cutoff) {
            continue;
          }
          try {
            await ch.delete();
          } catch {
            /* best effort */
          }
        }
      } catch {
        /* best effort */
      }
      await client.destroy();
    }
  });

  it("shows acknowledgment message before tool feedback", async () => {
    events.length = 0;

    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !("send" in channel)) {
      throw new Error(`Channel ${channelId} not found or not text-based`);
    }

    // Ask the bot to perform a task that involves multiple tools.
    await channel.send(
      `<@${CLAW_BOT_ID}> Check my todoist and google calendar for today. ` +
        `Give me a brief summary of what I have.`,
    );

    // Wait for the bot to respond.
    const startTime = Date.now();
    const maxWaitMs = 90_000;
    const quietPeriodMs = 15_000;
    let lastEventTime = startTime;

    while (Date.now() - startTime < maxWaitMs) {
      await new Promise((r) => setTimeout(r, 1000));

      const latestEvent = events[events.length - 1];
      if (latestEvent) {
        lastEventTime = latestEvent.timestamp;
      }

      const creates = events.filter((e) => e.type === "create");
      if (creates.length > 0 && Date.now() - lastEventTime >= quietPeriodMs) {
        break;
      }
    }

    const creates = events.filter((e) => e.type === "create");

    // Debug: log all captured messages.
    console.log(`[E2E] Captured ${creates.length} messages from Claw bot:`);
    for (const e of creates) {
      const preview = (e.content ?? "").slice(0, 150);
      console.log(`  [${e.messageId}] ${preview}`);
    }

    // The bot must have responded with at least one message.
    expect(creates.length).toBeGreaterThan(0);

    // Find the first tool feedback message (tool digests or result blocks).
    const toolFeedbackIndex = creates.findIndex((e) => {
      const c = e.content ?? "";
      return (
        c.includes("*Bash*") ||
        c.includes("*Running") ||
        c.includes("*Reading") ||
        c.match(/```/) || // Code blocks indicate tool output
        c.match(/\*[A-Z][a-z]+.*\(.*\).*\.\.\.\*/) // Rich tool format
      );
    });

    // If tool feedback exists, check that an acknowledgment came first.
    if (toolFeedbackIndex > 0) {
      const firstMessage = creates[0];
      const content = firstMessage?.content?.toLowerCase() ?? "";

      // The first message should be an acknowledgment, not tool feedback.
      const isAcknowledgment =
        content.includes("let me") ||
        content.includes("check") ||
        content.includes("look") ||
        content.includes("i'll") ||
        content.includes("give me") ||
        content.includes("sure") ||
        content.includes("pulling up") ||
        content.includes("moment");

      expect(isAcknowledgment).toBe(true);
    }

    // The final message should contain the answer.
    const finalReply = creates[creates.length - 1];
    expect(finalReply?.content).toBeTruthy();
  }, 120_000);
});
