import type { Client } from "@buape/carbon";
import { ChannelType, MessageType } from "@buape/carbon";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();
const updateLastRouteMock = vi.fn();
const dispatchMock = vi.fn();

vi.mock("./send.js", () => ({
  sendMessageDiscord: (...args: unknown[]) => sendMock(...args),
}));
vi.mock("../auto-reply/reply/dispatch-from-config.js", () => ({
  dispatchReplyFromConfig: (...args: unknown[]) => dispatchMock(...args),
}));
vi.mock("../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions.js")>();
  return {
    ...actual,
    resolveStorePath: vi.fn(() => "/tmp/clawdbot-sessions.json"),
    updateLastRoute: (...args: unknown[]) => updateLastRouteMock(...args),
    resolveSessionKey: vi.fn(),
  };
});

beforeEach(() => {
  sendMock.mockReset().mockResolvedValue(undefined);
  updateLastRouteMock.mockReset();
  dispatchMock.mockReset().mockImplementation(async ({ dispatcher }) => {
    dispatcher.sendFinalReply({ text: "hi" });
    return { queuedFinal: true, counts: { final: 1 } };
  });
  vi.resetModules();
});

describe("discord tool result dispatch", () => {
  it("sends status replies with responsePrefix", async () => {
    const { createDiscordMessageHandler } = await import("./monitor.js");
    const cfg = {
      agent: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/clawd" },
      session: { store: "/tmp/clawdbot-sessions.json" },
      messages: { responsePrefix: "PFX" },
      discord: { dm: { enabled: true, policy: "open" } },
      routing: { allowFrom: [] },
    } as ReturnType<typeof import("../config/config.js").loadConfig>;

    const runtimeError = vi.fn();
    const handler = createDiscordMessageHandler({
      cfg,
      token: "token",
      runtime: {
        log: vi.fn(),
        error: runtimeError,
        exit: (code: number): never => {
          throw new Error(`exit ${code}`);
        },
      },
      botUserId: "bot-id",
      guildHistories: new Map(),
      historyLimit: 0,
      mediaMaxBytes: 10_000,
      textLimit: 2000,
      replyToMode: "off",
      dmEnabled: true,
      groupDmEnabled: false,
    });

    const client = {
      fetchChannel: vi.fn().mockResolvedValue({
        type: ChannelType.DM,
        name: "dm",
      }),
    } as unknown as Client;

    await handler(
      {
        message: {
          id: "m1",
          content: "/status",
          channelId: "c1",
          timestamp: new Date().toISOString(),
          type: MessageType.Default,
          attachments: [],
          embeds: [],
          mentionedEveryone: false,
          mentionedUsers: [],
          mentionedRoles: [],
          author: { id: "u1", bot: false, username: "Ada" },
        },
        author: { id: "u1", bot: false, username: "Ada" },
        guild_id: null,
      },
      client,
    );

    expect(runtimeError).not.toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]?.[1]).toMatch(/^PFX /);
  }, 10000);

  it("accepts guild messages when mentionPatterns match", async () => {
    const { createDiscordMessageHandler } = await import("./monitor.js");
    const cfg = {
      agent: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/clawd" },
      session: { store: "/tmp/clawdbot-sessions.json" },
      messages: { responsePrefix: "PFX" },
      discord: {
        dm: { enabled: true, policy: "open" },
        guilds: { "*": { requireMention: true } },
      },
      routing: {
        allowFrom: [],
        groupChat: { mentionPatterns: ["\\bclawd\\b"] },
      },
    } as ReturnType<typeof import("../config/config.js").loadConfig>;

    const handler = createDiscordMessageHandler({
      cfg,
      token: "token",
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: (code: number): never => {
          throw new Error(`exit ${code}`);
        },
      },
      botUserId: "bot-id",
      guildHistories: new Map(),
      historyLimit: 0,
      mediaMaxBytes: 10_000,
      textLimit: 2000,
      replyToMode: "off",
      dmEnabled: true,
      groupDmEnabled: false,
      guildEntries: { "*": { requireMention: true } },
    });

    const client = {
      fetchChannel: vi.fn().mockResolvedValue({
        type: ChannelType.GuildText,
        name: "general",
      }),
    } as unknown as Client;

    await handler(
      {
        message: {
          id: "m2",
          content: "clawd: hello",
          channelId: "c1",
          timestamp: new Date().toISOString(),
          type: MessageType.Default,
          attachments: [],
          embeds: [],
          mentionedEveryone: false,
          mentionedUsers: [],
          mentionedRoles: [],
          author: { id: "u1", bot: false, username: "Ada" },
        },
        author: { id: "u1", bot: false, username: "Ada" },
        member: { nickname: "Ada" },
        guild: { id: "g1", name: "Guild" },
        guild_id: "g1",
      },
      client,
    );

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
  }, 10000);
});
