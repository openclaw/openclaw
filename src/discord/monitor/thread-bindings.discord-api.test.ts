import { ChannelType } from "discord-api-types/v10";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const restGet = vi.fn();
  const createDiscordRestClient = vi.fn(() => ({
    rest: {
      get: restGet,
    },
  }));
  return {
    restGet,
    createDiscordRestClient,
  };
});

vi.mock("../client.js", () => ({
  createDiscordRestClient: hoisted.createDiscordRestClient,
}));

const { resolveChannelIdForBinding } = await import("./thread-bindings.discord-api.js");

describe("resolveChannelIdForBinding", () => {
  beforeEach(() => {
    hoisted.restGet.mockReset();
    hoisted.createDiscordRestClient.mockClear();
  });

  it("returns explicit channelId without resolving route", async () => {
    const resolved = await resolveChannelIdForBinding({
      accountId: "default",
      threadId: "thread-1",
      channelId: "channel-explicit",
    });

    expect(resolved).toBe("channel-explicit");
    expect(hoisted.createDiscordRestClient).not.toHaveBeenCalled();
    expect(hoisted.restGet).not.toHaveBeenCalled();
  });

  it("returns parent channel for thread channels", async () => {
    hoisted.restGet.mockResolvedValueOnce({
      id: "thread-1",
      type: ChannelType.PublicThread,
      parent_id: "channel-parent",
    });

    const resolved = await resolveChannelIdForBinding({
      accountId: "default",
      threadId: "thread-1",
    });

    expect(resolved).toBe("channel-parent");
  });

  it("keeps non-thread channel id even when parent_id exists", async () => {
    hoisted.restGet.mockResolvedValueOnce({
      id: "channel-text",
      type: ChannelType.GuildText,
      parent_id: "category-1",
    });

    const resolved = await resolveChannelIdForBinding({
      accountId: "default",
      threadId: "channel-text",
    });

    expect(resolved).toBe("channel-text");
  });

  it("keeps forum channel id instead of parent category", async () => {
    hoisted.restGet.mockResolvedValueOnce({
      id: "forum-1",
      type: ChannelType.GuildForum,
      parent_id: "category-1",
    });

    const resolved = await resolveChannelIdForBinding({
      accountId: "default",
      threadId: "forum-1",
    });

    expect(resolved).toBe("forum-1");
  });
});
