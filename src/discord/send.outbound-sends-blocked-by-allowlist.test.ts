import { ChannelType } from "discord-api-types/v10";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiscordSendError } from "./send.types.js";

vi.mock("../web/media.js", () => ({
  loadWebMedia: vi.fn().mockResolvedValue({
    buffer: Buffer.from("img"),
    fileName: "photo.jpg",
    contentType: "image/jpeg",
    kind: "image",
  }),
}));

function createAllowlistConfig() {
  return {
    channels: {
      discord: {
        groupPolicy: "allowlist" as const,
        guilds: {
          "guild-allowed": {
            channels: {
              "chan-allowed": { allow: true },
            },
          },
        },
      },
    },
  };
}

let testConfig = createAllowlistConfig();

vi.mock("../config/config.js", async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    loadConfig: vi.fn(() => testConfig),
  };
});

const makeRest = () => {
  const postMock = vi.fn();
  const putMock = vi.fn();
  const getMock = vi.fn();
  const patchMock = vi.fn();
  const deleteMock = vi.fn();
  return {
    rest: {
      post: postMock,
      put: putMock,
      get: getMock,
      patch: patchMock,
      delete: deleteMock,
    } as unknown as import("@buape/carbon").RequestClient,
    postMock,
    putMock,
    getMock,
    patchMock,
    deleteMock,
  };
};

describe("outbound sends blocked by allowlist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testConfig = createAllowlistConfig();
  });

  describe("sendMessageDiscord", () => {
    it("throws outbound-blocked when channel is not in allowlist", async () => {
      const { sendMessageDiscord } = await import("./send.outbound.js");
      const { rest, getMock } = makeRest();
      getMock.mockResolvedValueOnce({
        type: ChannelType.GuildText,
        guild_id: "guild-allowed",
        parent_id: null,
      });

      let error: unknown;
      try {
        await sendMessageDiscord("channel:chan-blocked", "hello", {
          rest,
          token: "t",
        });
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(DiscordSendError);
      expect((error as DiscordSendError).kind).toBe("outbound-blocked");
    });

    it("allows sends to channels in the allowlist", async () => {
      const { sendMessageDiscord } = await import("./send.outbound.js");
      const { rest, getMock, postMock } = makeRest();
      getMock.mockResolvedValueOnce({
        type: ChannelType.GuildText,
        guild_id: "guild-allowed",
        parent_id: null,
      });
      postMock.mockResolvedValue({ id: "msg1", channel_id: "chan-allowed" });

      const result = await sendMessageDiscord("channel:chan-allowed", "hello", {
        rest,
        token: "t",
      });

      expect(result.messageId).toBe("msg1");
    });

    it("allows slug-keyed channel entries when channel name matches", async () => {
      testConfig = {
        channels: {
          discord: {
            groupPolicy: "allowlist",
            guilds: {
              "guild-allowed": {
                channels: {
                  general: { allow: true },
                },
              },
            },
          },
        },
      };
      const { sendMessageDiscord } = await import("./send.outbound.js");
      const { rest, getMock, postMock } = makeRest();
      getMock.mockResolvedValueOnce({
        type: ChannelType.GuildText,
        name: "general",
        guild_id: "guild-allowed",
        parent_id: null,
      });
      postMock.mockResolvedValue({ id: "msg1", channel_id: "123" });

      const result = await sendMessageDiscord("channel:123", "hello", {
        rest,
        token: "t",
      });

      expect(result.messageId).toBe("msg1");
    });

    it("allows slug-keyed guild entries by resolving guild name", async () => {
      testConfig = {
        channels: {
          discord: {
            groupPolicy: "allowlist",
            guilds: {
              "my-cool-server": {
                channels: {
                  "chan-allowed": { allow: true },
                },
              },
            },
          },
        },
      };
      const { sendMessageDiscord } = await import("./send.outbound.js");
      const { rest, getMock, postMock } = makeRest();
      getMock
        .mockResolvedValueOnce({
          type: ChannelType.GuildText,
          guild_id: "guild-123",
          name: "chan-allowed",
          parent_id: null,
        })
        .mockResolvedValueOnce({
          name: "My Cool Server",
        });
      postMock.mockResolvedValue({ id: "msg1", channel_id: "chan-allowed" });

      const result = await sendMessageDiscord("channel:chan-allowed", "hello", {
        rest,
        token: "t",
      });

      expect(result.messageId).toBe("msg1");
    });

    it("throws outbound-blocked when guild is not in allowlist", async () => {
      const { sendMessageDiscord } = await import("./send.outbound.js");
      const { rest, getMock } = makeRest();
      getMock.mockResolvedValueOnce({
        type: ChannelType.GuildText,
        guild_id: "guild-unknown",
        parent_id: null,
      });

      let error: unknown;
      try {
        await sendMessageDiscord("channel:some-chan", "hello", {
          rest,
          token: "t",
        });
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(DiscordSendError);
      expect((error as DiscordSendError).kind).toBe("outbound-blocked");
    });

    it("bypasses allowlist for DM sends", async () => {
      const { sendMessageDiscord } = await import("./send.outbound.js");
      const { rest, postMock } = makeRest();
      postMock
        .mockResolvedValueOnce({ id: "dm-chan" })
        .mockResolvedValueOnce({ id: "msg1", channel_id: "dm-chan" });

      const result = await sendMessageDiscord("user:123", "hi", {
        rest,
        token: "t",
      });

      expect(result.messageId).toBe("msg1");
    });

    it("throws channel-metadata-unavailable when fetch fails for non-DM", async () => {
      const { sendMessageDiscord } = await import("./send.outbound.js");
      const { rest, getMock } = makeRest();
      getMock.mockRejectedValueOnce(new Error("Network error"));

      let error: unknown;
      try {
        await sendMessageDiscord("channel:chan-allowed", "hello", {
          rest,
          token: "t",
        });
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(DiscordSendError);
      expect((error as DiscordSendError).kind).toBe("channel-metadata-unavailable");
    });
  });

  describe("sendStickerDiscord", () => {
    it("throws outbound-blocked when channel is not in allowlist", async () => {
      const { sendStickerDiscord } = await import("./send.outbound.js");
      const { rest, getMock } = makeRest();
      getMock.mockResolvedValueOnce({
        type: ChannelType.GuildText,
        guild_id: "guild-allowed",
        parent_id: null,
      });

      let error: unknown;
      try {
        await sendStickerDiscord("channel:chan-blocked", ["sticker1"], {
          rest,
          token: "t",
        });
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(DiscordSendError);
      expect((error as DiscordSendError).kind).toBe("outbound-blocked");
    });
  });

  describe("sendPollDiscord", () => {
    it("throws outbound-blocked when channel is not in allowlist", async () => {
      const { sendPollDiscord } = await import("./send.outbound.js");
      const { rest, getMock } = makeRest();
      getMock.mockResolvedValueOnce({
        type: ChannelType.GuildText,
        guild_id: "guild-allowed",
        parent_id: null,
      });

      let error: unknown;
      try {
        await sendPollDiscord(
          "channel:chan-blocked",
          { question: "Test?", options: ["A", "B"] },
          { rest, token: "t" },
        );
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(DiscordSendError);
      expect((error as DiscordSendError).kind).toBe("outbound-blocked");
    });
  });
});
