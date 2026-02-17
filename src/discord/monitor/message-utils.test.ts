import type { Message } from "@buape/carbon";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchRemoteMedia = vi.fn();
const saveMediaBuffer = vi.fn();

vi.mock("../../media/fetch.js", () => ({
  fetchRemoteMedia: (...args: unknown[]) => fetchRemoteMedia(...args),
}));

vi.mock("../../media/store.js", () => ({
  saveMediaBuffer: (...args: unknown[]) => saveMediaBuffer(...args),
}));

vi.mock("../../globals.js", () => ({
  logVerbose: () => {},
}));

const { resolveDiscordMessageChannelId, resolveForwardedMediaList } =
  await import("./message-utils.js");

function asMessage(payload: Record<string, unknown>): Message {
  return payload as Message;
}

describe("resolveDiscordMessageChannelId", () => {
  it("uses message.channelId when present", () => {
    const channelId = resolveDiscordMessageChannelId({
      message: asMessage({ channelId: " 123 " }),
    });
    expect(channelId).toBe("123");
  });

  it("falls back to message.channel_id", () => {
    const channelId = resolveDiscordMessageChannelId({
      message: asMessage({ channel_id: " 234 " }),
    });
    expect(channelId).toBe("234");
  });

  it("falls back to message.rawData.channel_id", () => {
    const channelId = resolveDiscordMessageChannelId({
      message: asMessage({ rawData: { channel_id: "456" } }),
    });
    expect(channelId).toBe("456");
  });

  it("falls back to eventChannelId and coerces numeric values", () => {
    const channelId = resolveDiscordMessageChannelId({
      message: asMessage({}),
      eventChannelId: 789,
    });
    expect(channelId).toBe("789");
  });
});

describe("resolveForwardedMediaList", () => {
  beforeEach(() => {
    fetchRemoteMedia.mockReset();
    saveMediaBuffer.mockReset();
  });

  it("downloads forwarded attachments", async () => {
    const attachment = {
      id: "att-1",
      url: "https://cdn.discordapp.com/attachments/1/image.png",
      filename: "image.png",
      content_type: "image/png",
    };
    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("image"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/image.png",
      contentType: "image/png",
    });

    const result = await resolveForwardedMediaList(
      asMessage({
        rawData: {
          message_snapshots: [{ message: { attachments: [attachment] } }],
        },
      }),
      512,
    );

    expect(fetchRemoteMedia).toHaveBeenCalledTimes(1);
    expect(fetchRemoteMedia).toHaveBeenCalledWith({
      url: attachment.url,
      filePathHint: attachment.filename,
    });
    expect(saveMediaBuffer).toHaveBeenCalledTimes(1);
    expect(saveMediaBuffer).toHaveBeenCalledWith(expect.any(Buffer), "image/png", "inbound", 512);
    expect(result).toEqual([
      {
        path: "/tmp/image.png",
        contentType: "image/png",
        placeholder: "<media:image>",
      },
    ]);
  });

  it("returns empty when no snapshots are present", async () => {
    const result = await resolveForwardedMediaList(asMessage({}), 512);

    expect(result).toEqual([]);
    expect(fetchRemoteMedia).not.toHaveBeenCalled();
  });

  it("skips snapshots without attachments", async () => {
    const result = await resolveForwardedMediaList(
      asMessage({
        rawData: {
          message_snapshots: [{ message: { content: "hello" } }],
        },
      }),
      512,
    );

    expect(result).toEqual([]);
    expect(fetchRemoteMedia).not.toHaveBeenCalled();
  });
});
