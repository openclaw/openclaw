import { Client, Events, GatewayIntentBits } from "discord.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "../../infra/env.js";

// Gated behind LIVE=1 — these tests hit real Discord.
const LIVE = isTruthyEnvValue(process.env.LIVE) || isTruthyEnvValue(process.env.CLAWDBOT_LIVE_TEST);
const describeLive = LIVE ? describe : describe.skip;

// The Claw bot's Discord user ID. Used to filter events to only
// track messages from the bot under test.
const CLAW_BOT_ID = process.env.DISCORD_E2E_CLAW_BOT_ID ?? "1468764779471700133";
const CHANNEL_ID = process.env.DISCORD_E2E_CHANNEL_ID ?? "1471323115450667073";

// Resolve the test bot token from env or ~/.keys.
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

describeLive("Discord message integrity", () => {
  let client: Client;
  let events: MessageEvent[];

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

    // Track all message events from the Claw bot in the test channel.
    client.on(Events.MessageCreate, (msg) => {
      if (msg.author.id === CLAW_BOT_ID && msg.channelId === CHANNEL_ID) {
        events.push({
          type: "create",
          messageId: msg.id,
          content: msg.content,
          timestamp: Date.now(),
        });
      }
    });

    client.on(Events.MessageUpdate, (_oldMsg, newMsg) => {
      if (newMsg.author?.id === CLAW_BOT_ID && newMsg.channelId === CHANNEL_ID) {
        events.push({
          type: "update",
          messageId: newMsg.id,
          content: newMsg.content ?? undefined,
          timestamp: Date.now(),
        });
      }
    });

    client.on(Events.MessageDelete, (msg) => {
      if (msg.channelId === CHANNEL_ID) {
        // We cannot always check author on deleted messages (partial),
        // so we check if this message ID was one we saw created by the
        // Claw bot. If we never saw it, we still record the delete for
        // safety.
        events.push({
          type: "delete",
          messageId: msg.id,
          timestamp: Date.now(),
        });
      }
    });

    await client.login(token);

    // Wait for the client to be fully ready.
    await new Promise<void>((resolve) => {
      if (client.isReady()) {
        resolve();
      } else {
        client.once(Events.ClientReady, () => resolve());
      }
    });
  }, 30000);

  afterAll(async () => {
    if (client) {
      await client.destroy();
    }
  });

  it("bot never edits or deletes messages during a response", async () => {
    events.length = 0;

    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel?.isTextBased() || !("send" in channel)) {
      throw new Error(`Channel ${CHANNEL_ID} not found or not text-based`);
    }

    // Send a simple greeting and wait for the bot to respond.
    await channel.send("Hello! What's your name?");

    // Wait for the bot to finish responding. Poll until we see at least
    // one created message and then a 10-second quiet period with no new
    // events, or time out after 60 seconds total.
    const startTime = Date.now();
    const maxWaitMs = 60000;
    const quietPeriodMs = 10000;

    let lastEventTime = startTime;

    while (Date.now() - startTime < maxWaitMs) {
      await new Promise((r) => setTimeout(r, 1000));

      const latestEvent = events[events.length - 1];
      if (latestEvent) {
        lastEventTime = latestEvent.timestamp;
      }

      // If we have at least one create and it's been quiet for the
      // required period, the bot is done responding.
      const creates = events.filter((e) => e.type === "create");
      if (creates.length > 0 && Date.now() - lastEventTime >= quietPeriodMs) {
        break;
      }
    }

    const creates = events.filter((e) => e.type === "create");
    const updates = events.filter((e) => e.type === "update");
    const deletes = events.filter((e) => e.type === "delete");

    // The bot must have responded.
    expect(creates.length).toBeGreaterThan(0);

    // No message should have been edited.
    expect(updates).toHaveLength(0);

    // No message should have been deleted.
    expect(deletes).toHaveLength(0);
  }, 90000);

  it("bot never edits or deletes messages for a complex request", async () => {
    events.length = 0;

    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel?.isTextBased() || !("send" in channel)) {
      throw new Error(`Channel ${CHANNEL_ID} not found or not text-based`);
    }

    // Send a more complex request that would trigger smart-ack and
    // tool usage, which is where the edit/delete bug was most visible.
    await channel.send(
      "Can you explain the difference between TCP and UDP protocols? " +
        "Include some real-world examples of when you'd use each one.",
    );

    const startTime = Date.now();
    const maxWaitMs = 90000;
    const quietPeriodMs = 10000;

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
    const deletes = events.filter((e) => e.type === "delete");

    expect(creates.length).toBeGreaterThan(0);
    expect(updates).toHaveLength(0);
    expect(deletes).toHaveLength(0);
  }, 120000);
});
