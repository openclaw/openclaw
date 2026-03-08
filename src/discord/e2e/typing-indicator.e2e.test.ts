import { Client, Events, GatewayIntentBits } from "discord.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "../../infra/env.js";
import {
  type MessageEvent,
  createE2eChannel,
  resolveE2eConfig,
  resolveTestBotToken,
  waitForBotResponse,
} from "./helpers.js";

// Gated behind LIVE=1 — these tests hit real Discord.
const LIVE = isTruthyEnvValue(process.env.LIVE) || isTruthyEnvValue(process.env.CLAWDBOT_LIVE_TEST);
const describeLive = LIVE ? describe : describe.skip;

const { botId: BOT_ID, guildId: GUILD_ID } = resolveE2eConfig();

describeLive("Discord typing indicator", () => {
  let client: Client;
  let channelId: string;
  let events: MessageEvent[];

  beforeAll(async () => {
    const token = resolveTestBotToken();
    events = [];

    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageTyping,
      ],
    });

    client.on(Events.MessageCreate, (msg) => {
      if (msg.author.id === BOT_ID && msg.channelId === channelId) {
        events.push({
          type: "create",
          messageId: msg.id,
          content: msg.content,
          timestamp: Date.now(),
        });
      }
    });

    await client.login(token);
    await new Promise<void>((resolve) => {
      if (client.isReady()) {
        resolve();
      } else {
        client.once(Events.ClientReady, () => resolve());
      }
    });

    const guild = await client.guilds.fetch(GUILD_ID);
    const channel = await createE2eChannel(guild, "typing-indicator E2E test");
    channelId = channel.id;
  }, 30000);

  afterAll(async () => {
    if (client) {
      await client.destroy();
    }
  });

  it("typing stops after bot sends reply (no lingering indicator)", async () => {
    events.length = 0;

    // Track typing events from the bot in the test channel.
    const typingEvents: { timestamp: number }[] = [];
    const typingHandler = (typing: { user: { id: string }; channel: { id: string } }) => {
      if (typing.user.id === BOT_ID && typing.channel.id === channelId) {
        typingEvents.push({ timestamp: Date.now() });
      }
    };
    client.on(Events.TypingStart, typingHandler);

    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !("send" in channel)) {
      throw new Error(`Channel ${channelId} not found or not text-based`);
    }

    // Send a simple message that should get a quick reply.
    await channel.send(`<@${BOT_ID}> Say "hello" and nothing else.`);

    // Wait for the bot to respond.
    await waitForBotResponse(events, 60_000, 10_000);

    const creates = events.filter((e) => e.type === "create");
    expect(creates.length).toBeGreaterThan(0);

    const lastReplyTime = creates[creates.length - 1]!.timestamp;

    // After the last reply, wait 8 seconds (longer than the
    // 6-second typing guard interval) and collect any late typing
    // events. There should be none after the reply was sent.
    await new Promise((r) => setTimeout(r, 8_000));

    client.off(Events.TypingStart, typingHandler);

    // Any typing event that arrived more than 1 second after the
    // last reply indicates a lingering indicator.
    const lateTyping = typingEvents.filter((t) => t.timestamp > lastReplyTime + 1_000);
    expect(lateTyping).toHaveLength(0);
  }, 90_000);
});
