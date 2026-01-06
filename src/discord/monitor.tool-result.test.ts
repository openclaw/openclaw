import { beforeEach, describe, expect, it, vi } from "vitest";

import { monitorDiscordProvider } from "./monitor.js";

const sendMock = vi.fn();
const replyMock = vi.fn();
const updateLastRouteMock = vi.fn();
let config: Record<string, unknown> = {};

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => config,
  };
});

vi.mock("../auto-reply/reply.js", () => ({
  getReplyFromConfig: (...args: unknown[]) => replyMock(...args),
}));

vi.mock("./send.js", () => ({
  sendMessageDiscord: (...args: unknown[]) => sendMock(...args),
}));

vi.mock("../config/sessions.js", () => ({
  resolveStorePath: vi.fn(() => "/tmp/clawdbot-sessions.json"),
  updateLastRoute: (...args: unknown[]) => updateLastRouteMock(...args),
  resolveSessionKey: vi.fn(),
}));

vi.mock("discord.js", () => {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  class Client {
    static lastClient: Client | null = null;
    user = { id: "bot-id", tag: "bot#1" };
    constructor() {
      Client.lastClient = this;
    }
    on(event: string, handler: (...args: unknown[]) => void) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)?.add(handler);
    }
    once(event: string, handler: (...args: unknown[]) => void) {
      this.on(event, handler);
    }
    off(event: string, handler: (...args: unknown[]) => void) {
      handlers.get(event)?.delete(handler);
    }
    emit(event: string, ...args: unknown[]) {
      for (const handler of handlers.get(event) ?? []) {
        Promise.resolve(handler(...args)).catch(() => {});
      }
    }
    login = vi.fn().mockResolvedValue(undefined);
    destroy = vi.fn().mockResolvedValue(undefined);
  }

  return {
    Client,
    __getLastClient: () => Client.lastClient,
    Events: {
      ClientReady: "ready",
      Error: "error",
      MessageCreate: "messageCreate",
      MessageReactionAdd: "reactionAdd",
      MessageReactionRemove: "reactionRemove",
    },
    ChannelType: {
      DM: "dm",
      GroupDM: "group_dm",
      GuildText: "guild_text",
    },
    MessageType: {
      Default: "default",
      ChatInputCommand: "chat_command",
      ContextMenuCommand: "context_command",
    },
    GatewayIntentBits: {},
    Partials: {},
  };
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function waitForClient() {
  const discord = (await import("discord.js")) as unknown as {
    __getLastClient: () => { emit: (...args: unknown[]) => void } | null;
  };
  for (let i = 0; i < 10; i += 1) {
    const client = discord.__getLastClient();
    if (client) return client;
    await flush();
  }
  return null;
}

beforeEach(() => {
  config = {
    messages: { responsePrefix: "PFX" },
    discord: { dm: { enabled: true } },
    routing: { allowFrom: [] },
  };
  sendMock.mockReset().mockResolvedValue(undefined);
  replyMock.mockReset();
  updateLastRouteMock.mockReset();
});

describe("monitorDiscordProvider tool results", () => {
  it("sends tool summaries with responsePrefix", async () => {
    replyMock.mockImplementation(async (_ctx, opts) => {
      await opts?.onToolResult?.({ text: "tool update" });
      return { text: "final reply" };
    });

    const controller = new AbortController();
    const run = monitorDiscordProvider({
      token: "token",
      abortSignal: controller.signal,
    });

    const discord = await import("discord.js");
    const client = await waitForClient();
    if (!client) throw new Error("Discord client not created");

    client.emit(discord.Events.MessageCreate, {
      id: "m1",
      content: "hello",
      author: { id: "u1", bot: false, username: "Ada" },
      channelId: "c1",
      channel: {
        type: discord.ChannelType.DM,
        isSendable: () => false,
      },
      guild: undefined,
      mentions: { has: () => false },
      attachments: { first: () => undefined },
      type: discord.MessageType.Default,
      createdTimestamp: Date.now(),
    });

    await flush();
    controller.abort();
    await run;

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[0][1]).toBe("PFX tool update");
    expect(sendMock.mock.calls[1][1]).toBe("PFX final reply");
  });

  it("accepts guild messages when mentionPatterns match", async () => {
    config = {
      messages: { responsePrefix: "PFX" },
      discord: {
        dm: { enabled: true },
        guilds: { "*": { requireMention: true } },
      },
      routing: {
        allowFrom: [],
        groupChat: { mentionPatterns: ["\\bclawd\\b"] },
      },
    };
    replyMock.mockResolvedValue({ text: "hi" });

    const controller = new AbortController();
    const run = monitorDiscordProvider({
      token: "token",
      abortSignal: controller.signal,
    });

    const discord = await import("discord.js");
    const client = await waitForClient();
    if (!client) throw new Error("Discord client not created");

    client.emit(discord.Events.MessageCreate, {
      id: "m2",
      content: "clawd: hello",
      author: { id: "u1", bot: false, username: "Ada", tag: "Ada#1" },
      member: { displayName: "Ada" },
      channelId: "c1",
      channel: {
        type: discord.ChannelType.GuildText,
        name: "general",
        isSendable: () => false,
      },
      guild: { id: "g1", name: "Guild" },
      mentions: {
        has: () => false,
        everyone: false,
        users: { size: 0 },
        roles: { size: 0 },
      },
      attachments: { first: () => undefined },
      type: discord.MessageType.Default,
      createdTimestamp: Date.now(),
    });

    await flush();
    controller.abort();
    await run;

    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(replyMock.mock.calls[0][0].WasMentioned).toBe(true);
  });
});
