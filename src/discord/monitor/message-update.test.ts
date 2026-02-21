import { ChannelType } from "@buape/carbon";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { DiscordMessageUpdateListener, type DiscordMessageUpdateEvent } from "./listeners.js";
import { __resetDiscordChannelInfoCacheForTest } from "./message-utils.js";

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

describe("DiscordMessageUpdateListener", () => {
  const enqueueSystemEventMock = vi.mocked(enqueueSystemEvent);

  beforeEach(() => {
    enqueueSystemEventMock.mockReset();
    __resetDiscordChannelInfoCacheForTest();
  });

  it("enqueues system event for edited DMs", async () => {
    const cfg = { channels: { discord: {} } } as OpenClawConfig;
    const listener = new DiscordMessageUpdateListener({
      cfg,
      accountId: "default",
      runtime: { error: vi.fn() } as unknown as import("../../runtime.js").RuntimeEnv,
      botUserId: "bot-1",
      guildEntries: undefined,
      logger: { error: vi.fn(), warn: vi.fn() } as unknown as ReturnType<
        typeof import("../../logging/subsystem.js").createSubsystemLogger
      >,
      dmEnabled: true,
      dmPolicy: "open",
      allowFrom: [],
      groupPolicy: "open",
      groupDmEnabled: false,
      groupDmChannels: undefined,
      allowBots: false,
    });

    const message = {
      id: "msg-1",
      channelId: "dm-1",
      editedTimestamp: "2026-02-20T00:00:00.000Z",
      author: { id: "user-1", username: "Ada", discriminator: "0001", bot: false },
    } as unknown as import("@buape/carbon").Message;

    const client = {
      fetchChannel: vi.fn(async () => ({ type: ChannelType.DM })),
    } as unknown as import("@buape/carbon").Client;

    await listener.handle(
      {
        channel_id: "dm-1",
        message,
      } as DiscordMessageUpdateEvent,
      client,
    );

    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "Discord message edited in DM.",
      expect.objectContaining({
        contextKey: "discord:message:edited:dm-1:msg-1",
      }),
    );
  });

  it("skips system event when guild allowlist blocks sender", async () => {
    const cfg = { channels: { discord: {} } } as OpenClawConfig;
    const listener = new DiscordMessageUpdateListener({
      cfg,
      accountId: "default",
      runtime: { error: vi.fn() } as unknown as import("../../runtime.js").RuntimeEnv,
      botUserId: "bot-1",
      guildEntries: {
        "guild-1": { users: ["user-allowed"] },
      },
      logger: { error: vi.fn(), warn: vi.fn() } as unknown as ReturnType<
        typeof import("../../logging/subsystem.js").createSubsystemLogger
      >,
      dmEnabled: true,
      dmPolicy: "open",
      allowFrom: [],
      groupPolicy: "open",
      groupDmEnabled: false,
      groupDmChannels: undefined,
      allowBots: false,
    });

    const message = {
      id: "msg-2",
      channelId: "channel-1",
      editedTimestamp: "2026-02-20T00:00:00.000Z",
      author: { id: "user-blocked", username: "Ada", discriminator: "0001", bot: false },
    } as unknown as import("@buape/carbon").Message;

    const client = {
      fetchChannel: vi.fn(async () => ({ type: ChannelType.GuildText })),
    } as unknown as import("@buape/carbon").Client;

    await listener.handle(
      {
        channel_id: "channel-1",
        guild_id: "guild-1",
        guild: { id: "guild-1", name: "Test Guild" },
        member: { roles: [] },
        message,
      } as DiscordMessageUpdateEvent,
      client,
    );

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });
});
