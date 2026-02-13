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

describeLive("Discord tool feedback display", () => {
  let client: Client;
  let channelId: string;
  let events: MessageEvent[];
  const nonce = randomBytes(4).toString("hex");
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const channelName = `e2e-${today}-${nonce}`;
  const probePath = path.join(os.tmpdir(), `e2e-probe-${nonce}.txt`);

  beforeAll(async () => {
    const token = resolveTestBotToken();
    events = [];

    // Write probe file for the Claw bot to read.
    fs.writeFileSync(probePath, `E2E probe content: ${nonce}\n`);

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
      topic: `E2E tool feedback test (auto-created, safe to delete)`,
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
    // Clean up probe file.
    try {
      fs.unlinkSync(probePath);
    } catch {
      /* already gone */
    }
    // Prune E2E channels older than 7 days (based on the date in the
    // channel name). Keep the current test channel for inspection.
    if (client) {
      try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const channels = await guild.channels.fetch();
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        for (const [, ch] of channels) {
          if (!ch) continue;
          const match = ch.name.match(/^e2e-(\d{4}-\d{2}-\d{2})-/);
          if (!match) continue;
          const channelDate = new Date(match[1]).getTime();
          if (Number.isNaN(channelDate) || channelDate >= cutoff) continue;
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

  it("shows rich tool feedback when the bot reads a file", async () => {
    events.length = 0;

    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !("send" in channel)) {
      throw new Error(`Channel ${channelId} not found or not text-based`);
    }

    // Ask the Claw bot to read our probe file.
    await channel.send(
      `<@${CLAW_BOT_ID}> I left a file at ${probePath} for you. ` +
        `Read it and tell me what it says. This is for an E2E test.`,
    );

    // Wait for the bot to respond. Poll until we see at least one
    // created message and a 15-second quiet period, or 90 seconds total.
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
    const updates = events.filter((e) => e.type === "update");

    // Debug: log all captured messages so failures are diagnosable.
    console.log(`[E2E] Captured ${creates.length} messages from Claw bot:`);
    for (const e of creates) {
      const preview = (e.content ?? "").slice(0, 120);
      console.log(`  [${e.type}] ${preview}`);
    }

    // The bot must have responded with at least one message.
    expect(creates.length).toBeGreaterThan(0);

    // No edits allowed.
    expect(updates).toHaveLength(0);

    // At least one message should contain tool feedback. Accept both
    // the new rich format (*Read*, *Bash*) and the old italic format
    // (*Reading ...*) so the test works against both old and new code.
    const hasToolFeedback = creates.some((e) => {
      const c = e.content ?? "";
      return (
        c.includes("*Read*") ||
        c.includes("*Bash*") ||
        c.includes("*Reading") ||
        c.includes("*Running")
      );
    });

    expect(hasToolFeedback).toBe(true);

    // The final reply should contain the probe content.
    const finalReply = creates[creates.length - 1];
    expect(finalReply?.content).toContain(nonce);
  }, 120_000);
});
