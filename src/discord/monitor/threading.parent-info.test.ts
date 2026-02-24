import { ChannelType } from "@buape/carbon";
import { describe, expect, it, vi } from "vitest";
import { resolveDiscordThreadParentInfo } from "./threading.js";

describe("resolveDiscordThreadParentInfo", () => {
  it("falls back to fetched thread parentId when parentId is missing in payload", async () => {
    const fetchChannel = vi.fn(async (channelId: string) => {
      if (channelId === "thread-1") {
        return {
          id: "thread-1",
          type: ChannelType.PublicThread,
          name: "thread-name",
          parentId: "parent-1",
        };
      }
      if (channelId === "parent-1") {
        return {
          id: "parent-1",
          type: ChannelType.GuildText,
          name: "parent-name",
        };
      }
      return null;
    });

    const client = {
      fetchChannel,
    } as unknown as import("@buape/carbon").Client;

    const result = await resolveDiscordThreadParentInfo({
      client,
      threadChannel: {
        id: "thread-1",
        parentId: undefined,
      },
      channelInfo: null,
    });

    expect(fetchChannel).toHaveBeenCalledWith("thread-1");
    expect(fetchChannel).toHaveBeenCalledWith("parent-1");
    expect(result).toEqual({
      id: "parent-1",
      name: "parent-name",
      type: ChannelType.GuildText,
    });
  });
});
