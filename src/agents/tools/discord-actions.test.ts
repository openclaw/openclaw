import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscordActionConfig, OpenClawConfig } from "../../config/config.js";
import { handleDiscordGuildAction } from "./discord-actions-guild.js";
import { handleDiscordMessagingAction } from "./discord-actions-messaging.js";
import { handleDiscordModerationAction } from "./discord-actions-moderation.js";
import { handleDiscordAction } from "./discord-actions.js";

const discordSendMocks = vi.hoisted(() => ({
  banMemberDiscord: vi.fn(async () => ({})),
  createChannelDiscord: vi.fn(async () => ({
    id: "new-channel",
    name: "test",
    type: 0,
  })),
  createThreadDiscord: vi.fn(async () => ({})),
  deleteChannelDiscord: vi.fn(async () => ({ ok: true, channelId: "C1" })),
  deleteMessageDiscord: vi.fn(async () => ({})),
  editChannelDiscord: vi.fn(async () => ({
    id: "C1",
    name: "edited",
  })),
  editMessageDiscord: vi.fn(async () => ({})),
  fetchChannelPermissionsDiscord: vi.fn(async () => ({})),
  fetchMessageDiscord: vi.fn(async () => ({})),
  fetchReactionsDiscord: vi.fn(async () => ({})),
  kickMemberDiscord: vi.fn(async () => ({})),
  listGuildChannelsDiscord: vi.fn(async () => []),
  listPinsDiscord: vi.fn(async () => ({})),
  listThreadsDiscord: vi.fn(async () => ({})),
  moveChannelDiscord: vi.fn(async () => ({ ok: true })),
  pinMessageDiscord: vi.fn(async () => ({})),
  reactMessageDiscord: vi.fn(async () => ({})),
  readMessagesDiscord: vi.fn(async () => []),
  removeChannelPermissionDiscord: vi.fn(async () => ({ ok: true })),
  removeOwnReactionsDiscord: vi.fn(async () => ({ removed: ["👍"] })),
  removeReactionDiscord: vi.fn(async () => ({})),
  searchMessagesDiscord: vi.fn(async () => ({})),
  sendMessageDiscord: vi.fn(async () => ({})),
  sendPollDiscord: vi.fn(async () => ({})),
  sendStickerDiscord: vi.fn(async () => ({})),
  sendVoiceMessageDiscord: vi.fn(async () => ({})),
  setChannelPermissionDiscord: vi.fn(async () => ({ ok: true })),
  timeoutMemberDiscord: vi.fn(async () => ({})),
  unpinMessageDiscord: vi.fn(async () => ({})),
}));

const {
  createChannelDiscord,
  createThreadDiscord,
  deleteChannelDiscord,
  editChannelDiscord,
  fetchMessageDiscord,
  kickMemberDiscord,
  listGuildChannelsDiscord,
  listPinsDiscord,
  moveChannelDiscord,
  reactMessageDiscord,
  readMessagesDiscord,
  removeChannelPermissionDiscord,
  removeOwnReactionsDiscord,
  removeReactionDiscord,
  searchMessagesDiscord,
  sendMessageDiscord,
  sendVoiceMessageDiscord,
  setChannelPermissionDiscord,
  timeoutMemberDiscord,
} = discordSendMocks;

vi.mock("../../discord/send.js", () => ({
  ...discordSendMocks,
}));

const enableAllActions = () => true;

const disabledActions = (key: keyof DiscordActionConfig) => key !== "reactions";
const channelInfoEnabled = (key: keyof DiscordActionConfig) => key === "channelInfo";
const moderationEnabled = (key: keyof DiscordActionConfig) => key === "moderation";

describe("handleDiscordMessagingAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    {
      name: "without account",
      params: {
        channelId: "C1",
        messageId: "M1",
        emoji: "✅",
      },
      expectedOptions: undefined,
    },
    {
      name: "with accountId",
      params: {
        channelId: "C1",
        messageId: "M1",
        emoji: "✅",
        accountId: "ops",
      },
      expectedOptions: { accountId: "ops" },
    },
  ])("adds reactions $name", async ({ params, expectedOptions }) => {
    await handleDiscordMessagingAction("react", params, enableAllActions);
    if (expectedOptions) {
      expect(reactMessageDiscord).toHaveBeenCalledWith("C1", "M1", "✅", expectedOptions);
      return;
    }
    expect(reactMessageDiscord).toHaveBeenCalledWith("C1", "M1", "✅");
  });

  it("removes reactions on empty emoji", async () => {
    await handleDiscordMessagingAction(
      "react",
      {
        channelId: "C1",
        messageId: "M1",
        emoji: "",
      },
      enableAllActions,
    );
    expect(removeOwnReactionsDiscord).toHaveBeenCalledWith("C1", "M1");
  });

  it("removes reactions when remove flag set", async () => {
    await handleDiscordMessagingAction(
      "react",
      {
        channelId: "C1",
        messageId: "M1",
        emoji: "✅",
        remove: true,
      },
      enableAllActions,
    );
    expect(removeReactionDiscord).toHaveBeenCalledWith("C1", "M1", "✅");
  });

  it("rejects removes without emoji", async () => {
    await expect(
      handleDiscordMessagingAction(
        "react",
        {
          channelId: "C1",
          messageId: "M1",
          emoji: "",
          remove: true,
        },
        enableAllActions,
      ),
    ).rejects.toThrow(/Emoji is required/);
  });

  it("respects reaction gating", async () => {
    await expect(
      handleDiscordMessagingAction(
        "react",
        {
          channelId: "C1",
          messageId: "M1",
          emoji: "✅",
        },
        disabledActions,
      ),
    ).rejects.toThrow(/Discord reactions are disabled/);
  });

  it("adds normalized timestamps to readMessages payloads", async () => {
    readMessagesDiscord.mockResolvedValueOnce([
      { id: "1", timestamp: "2026-01-15T10:00:00.000Z" },
    ] as never);

    const result = await handleDiscordMessagingAction(
      "readMessages",
      { channelId: "C1" },
      enableAllActions,
    );
    const payload = result.details as {
      messages: Array<{ timestampMs?: number; timestampUtc?: string }>;
    };

    const expectedMs = Date.parse("2026-01-15T10:00:00.000Z");
    expect(payload.messages[0].timestampMs).toBe(expectedMs);
    expect(payload.messages[0].timestampUtc).toBe(new Date(expectedMs).toISOString());
  });

  it("adds normalized timestamps to fetchMessage payloads", async () => {
    fetchMessageDiscord.mockResolvedValueOnce({
      id: "1",
      timestamp: "2026-01-15T11:00:00.000Z",
    });

    const result = await handleDiscordMessagingAction(
      "fetchMessage",
      { guildId: "G1", channelId: "C1", messageId: "M1" },
      enableAllActions,
    );
    const payload = result.details as { message?: { timestampMs?: number; timestampUtc?: string } };

    const expectedMs = Date.parse("2026-01-15T11:00:00.000Z");
    expect(payload.message?.timestampMs).toBe(expectedMs);
    expect(payload.message?.timestampUtc).toBe(new Date(expectedMs).toISOString());
  });

  it("adds normalized timestamps to listPins payloads", async () => {
    listPinsDiscord.mockResolvedValueOnce([{ id: "1", timestamp: "2026-01-15T12:00:00.000Z" }]);

    const result = await handleDiscordMessagingAction(
      "listPins",
      { channelId: "C1" },
      enableAllActions,
    );
    const payload = result.details as {
      pins: Array<{ timestampMs?: number; timestampUtc?: string }>;
    };

    const expectedMs = Date.parse("2026-01-15T12:00:00.000Z");
    expect(payload.pins[0].timestampMs).toBe(expectedMs);
    expect(payload.pins[0].timestampUtc).toBe(new Date(expectedMs).toISOString());
  });

  it("adds normalized timestamps to searchMessages payloads", async () => {
    searchMessagesDiscord.mockResolvedValueOnce({
      total_results: 1,
      messages: [[{ id: "1", timestamp: "2026-01-15T13:00:00.000Z" }]],
    });

    const result = await handleDiscordMessagingAction(
      "searchMessages",
      { guildId: "G1", content: "hi" },
      enableAllActions,
    );
    const payload = result.details as {
      results?: { messages?: Array<Array<{ timestampMs?: number; timestampUtc?: string }>> };
    };

    const expectedMs = Date.parse("2026-01-15T13:00:00.000Z");
    expect(payload.results?.messages?.[0]?.[0]?.timestampMs).toBe(expectedMs);
    expect(payload.results?.messages?.[0]?.[0]?.timestampUtc).toBe(
      new Date(expectedMs).toISOString(),
    );
  });

  it("sends voice messages from a local file path", async () => {
    sendVoiceMessageDiscord.mockClear();
    sendMessageDiscord.mockClear();

    await handleDiscordMessagingAction(
      "sendMessage",
      {
        to: "channel:123",
        path: "/tmp/voice.mp3",
        asVoice: true,
        silent: true,
      },
      enableAllActions,
    );

    expect(sendVoiceMessageDiscord).toHaveBeenCalledWith("channel:123", "/tmp/voice.mp3", {
      replyTo: undefined,
      silent: true,
    });
    expect(sendMessageDiscord).not.toHaveBeenCalled();
  });

  it("forwards trusted mediaLocalRoots into sendMessageDiscord", async () => {
    sendMessageDiscord.mockClear();
    await handleDiscordMessagingAction(
      "sendMessage",
      {
        to: "channel:123",
        content: "hello",
        mediaUrl: "/tmp/image.png",
      },
      enableAllActions,
      { mediaLocalRoots: ["/tmp/agent-root"] },
    );
    expect(sendMessageDiscord).toHaveBeenCalledWith(
      "channel:123",
      "hello",
      expect.objectContaining({
        mediaUrl: "/tmp/image.png",
        mediaLocalRoots: ["/tmp/agent-root"],
      }),
    );
  });

  it("rejects voice messages that include content", async () => {
    await expect(
      handleDiscordMessagingAction(
        "sendMessage",
        {
          to: "channel:123",
          mediaUrl: "/tmp/voice.mp3",
          asVoice: true,
          content: "hello",
        },
        enableAllActions,
      ),
    ).rejects.toThrow(/Voice messages cannot include text content/);
  });

  it("forwards optional thread content", async () => {
    createThreadDiscord.mockClear();
    await handleDiscordMessagingAction(
      "threadCreate",
      {
        channelId: "C1",
        name: "Forum thread",
        content: "Initial forum post body",
      },
      enableAllActions,
    );
    expect(createThreadDiscord).toHaveBeenCalledWith("C1", {
      name: "Forum thread",
      messageId: undefined,
      autoArchiveMinutes: undefined,
      content: "Initial forum post body",
    });
  });
});

const channelsEnabled = (key: keyof DiscordActionConfig) => key === "channels";
const channelsDisabled = () => false;

describe("handleDiscordGuildAction - channel management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a channel", async () => {
    const result = await handleDiscordGuildAction(
      "channelCreate",
      {
        guildId: "G1",
        name: "test-channel",
        type: 0,
        topic: "Test topic",
      },
      channelsEnabled,
    );
    expect(createChannelDiscord).toHaveBeenCalledWith({
      guildId: "G1",
      name: "test-channel",
      type: 0,
      parentId: undefined,
      topic: "Test topic",
      position: undefined,
      nsfw: undefined,
    });
    expect(result.details).toMatchObject({ ok: true });
  });

  it("respects channel gating for channelCreate", async () => {
    await expect(
      handleDiscordGuildAction("channelCreate", { guildId: "G1", name: "test" }, channelsDisabled),
    ).rejects.toThrow(/Discord channel management is disabled/);
  });

  it("forwards accountId for channelList", async () => {
    await handleDiscordGuildAction(
      "channelList",
      { guildId: "G1", accountId: "ops" },
      channelInfoEnabled,
    );
    expect(listGuildChannelsDiscord).toHaveBeenCalledWith("G1", { accountId: "ops" });
  });

  it("edits a channel", async () => {
    await handleDiscordGuildAction(
      "channelEdit",
      {
        channelId: "C1",
        name: "new-name",
        topic: "new topic",
      },
      channelsEnabled,
    );
    expect(editChannelDiscord).toHaveBeenCalledWith({
      channelId: "C1",
      name: "new-name",
      topic: "new topic",
      position: undefined,
      parentId: undefined,
      nsfw: undefined,
      rateLimitPerUser: undefined,
      archived: undefined,
      locked: undefined,
      autoArchiveDuration: undefined,
    });
  });

  it("forwards thread edit fields", async () => {
    await handleDiscordGuildAction(
      "channelEdit",
      {
        channelId: "C1",
        archived: true,
        locked: false,
        autoArchiveDuration: 1440,
      },
      channelsEnabled,
    );
    expect(editChannelDiscord).toHaveBeenCalledWith({
      channelId: "C1",
      name: undefined,
      topic: undefined,
      position: undefined,
      parentId: undefined,
      nsfw: undefined,
      rateLimitPerUser: undefined,
      archived: true,
      locked: false,
      autoArchiveDuration: 1440,
    });
  });

  it.each([
    ["parentId is null", { parentId: null }],
    ["clearParent is true", { clearParent: true }],
  ])("clears the channel parent when %s", async (_label, payload) => {
    await handleDiscordGuildAction(
      "channelEdit",
      {
        channelId: "C1",
        ...payload,
      },
      channelsEnabled,
    );
    expect(editChannelDiscord).toHaveBeenCalledWith({
      channelId: "C1",
      name: undefined,
      topic: undefined,
      position: undefined,
      parentId: null,
      nsfw: undefined,
      rateLimitPerUser: undefined,
      archived: undefined,
      locked: undefined,
      autoArchiveDuration: undefined,
    });
  });

  it("deletes a channel", async () => {
    await handleDiscordGuildAction("channelDelete", { channelId: "C1" }, channelsEnabled);
    expect(deleteChannelDiscord).toHaveBeenCalledWith("C1");
  });

  it("moves a channel", async () => {
    await handleDiscordGuildAction(
      "channelMove",
      {
        guildId: "G1",
        channelId: "C1",
        parentId: "P1",
        position: 5,
      },
      channelsEnabled,
    );
    expect(moveChannelDiscord).toHaveBeenCalledWith({
      guildId: "G1",
      channelId: "C1",
      parentId: "P1",
      position: 5,
    });
  });

  it.each([
    ["parentId is null", { parentId: null }],
    ["clearParent is true", { clearParent: true }],
  ])("clears the channel parent on move when %s", async (_label, payload) => {
    await handleDiscordGuildAction(
      "channelMove",
      {
        guildId: "G1",
        channelId: "C1",
        ...payload,
      },
      channelsEnabled,
    );
    expect(moveChannelDiscord).toHaveBeenCalledWith({
      guildId: "G1",
      channelId: "C1",
      parentId: null,
      position: undefined,
    });
  });

  it("creates a category with type=4", async () => {
    await handleDiscordGuildAction(
      "categoryCreate",
      { guildId: "G1", name: "My Category" },
      channelsEnabled,
    );
    expect(createChannelDiscord).toHaveBeenCalledWith({
      guildId: "G1",
      name: "My Category",
      type: 4,
      position: undefined,
    });
  });

  it("edits a category", async () => {
    await handleDiscordGuildAction(
      "categoryEdit",
      { categoryId: "CAT1", name: "Renamed Category" },
      channelsEnabled,
    );
    expect(editChannelDiscord).toHaveBeenCalledWith({
      channelId: "CAT1",
      name: "Renamed Category",
      position: undefined,
    });
  });

  it("deletes a category", async () => {
    await handleDiscordGuildAction("categoryDelete", { categoryId: "CAT1" }, channelsEnabled);
    expect(deleteChannelDiscord).toHaveBeenCalledWith("CAT1");
  });

  it.each([
    {
      name: "role",
      params: {
        channelId: "C1",
        targetId: "R1",
        targetType: "role" as const,
        allow: "1024",
        deny: "2048",
      },
      expected: {
        channelId: "C1",
        targetId: "R1",
        targetType: 0,
        allow: "1024",
        deny: "2048",
      },
    },
    {
      name: "member",
      params: {
        channelId: "C1",
        targetId: "U1",
        targetType: "member" as const,
        allow: "1024",
      },
      expected: {
        channelId: "C1",
        targetId: "U1",
        targetType: 1,
        allow: "1024",
        deny: undefined,
      },
    },
  ])("sets channel permissions for $name", async ({ params, expected }) => {
    await handleDiscordGuildAction("channelPermissionSet", params, channelsEnabled);
    expect(setChannelPermissionDiscord).toHaveBeenCalledWith(expected);
  });

  it("removes channel permissions", async () => {
    await handleDiscordGuildAction(
      "channelPermissionRemove",
      { channelId: "C1", targetId: "R1" },
      channelsEnabled,
    );
    expect(removeChannelPermissionDiscord).toHaveBeenCalledWith("C1", "R1");
  });
});

describe("handleDiscordModerationAction", () => {
  it("forwards accountId for timeout", async () => {
    await handleDiscordModerationAction(
      "timeout",
      {
        guildId: "G1",
        userId: "U1",
        durationMinutes: 5,
        accountId: "ops",
      },
      moderationEnabled,
    );
    expect(timeoutMemberDiscord).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "G1",
        userId: "U1",
        durationMinutes: 5,
      }),
      { accountId: "ops" },
    );
  });
});

describe("handleDiscordAction per-account gating", () => {
  it("allows moderation when account config enables it", async () => {
    const cfg = {
      channels: {
        discord: {
          accounts: {
            ops: { token: "tok-ops", actions: { moderation: true } },
          },
        },
      },
    } as OpenClawConfig;

    await handleDiscordAction(
      { action: "timeout", guildId: "G1", userId: "U1", durationMinutes: 5, accountId: "ops" },
      cfg,
    );
    expect(timeoutMemberDiscord).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: "G1", userId: "U1" }),
      { accountId: "ops" },
    );
  });

  it("blocks moderation when account omits it", async () => {
    const cfg = {
      channels: {
        discord: {
          accounts: {
            chat: { token: "tok-chat" },
          },
        },
      },
    } as OpenClawConfig;

    await expect(
      handleDiscordAction(
        { action: "timeout", guildId: "G1", userId: "U1", durationMinutes: 5, accountId: "chat" },
        cfg,
      ),
    ).rejects.toThrow(/Discord moderation is disabled/);
  });

  it("uses account-merged config, not top-level config", async () => {
    // Top-level has no moderation, but the account does
    const cfg = {
      channels: {
        discord: {
          token: "tok-base",
          accounts: {
            ops: { token: "tok-ops", actions: { moderation: true } },
          },
        },
      },
    } as OpenClawConfig;

    await handleDiscordAction(
      { action: "kick", guildId: "G1", userId: "U1", accountId: "ops" },
      cfg,
    );
    expect(kickMemberDiscord).toHaveBeenCalled();
  });

  it("inherits top-level channel gate when account overrides moderation only", async () => {
    const cfg = {
      channels: {
        discord: {
          actions: { channels: false },
          accounts: {
            ops: { token: "tok-ops", actions: { moderation: true } },
          },
        },
      },
    } as OpenClawConfig;

    await expect(
      handleDiscordAction(
        { action: "channelCreate", guildId: "G1", name: "alerts", accountId: "ops" },
        cfg,
      ),
    ).rejects.toThrow(/channel management is disabled/i);
  });

  it("allows account to explicitly re-enable top-level disabled channel gate", async () => {
    const cfg = {
      channels: {
        discord: {
          actions: { channels: false },
          accounts: {
            ops: {
              token: "tok-ops",
              actions: { moderation: true, channels: true },
            },
          },
        },
      },
    } as OpenClawConfig;

    await handleDiscordAction(
      { action: "channelCreate", guildId: "G1", name: "alerts", accountId: "ops" },
      cfg,
    );

    expect(createChannelDiscord).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: "G1", name: "alerts" }),
      { accountId: "ops" },
    );
  });
});
