import { ChannelType, type Client, type Message } from "@buape/carbon";
import { StickerFormatType } from "discord-api-types/v10";
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

const {
  __resetDiscordChannelInfoCacheForTest,
  resolveDiscordChannelInfo,
  resolveDiscordMessageChannelId,
  resolveDiscordMessageText,
  resolveForwardedMediaList,
  resolveMediaList,
} = await import("./message-utils.js");

function asMessage(payload: Record<string, unknown>): Message {
  return payload as unknown as Message;
}

describe("resolveDiscordMessageChannelId", () => {
  it.each([
    {
      name: "uses message.channelId when present",
      params: { message: asMessage({ channelId: " 123 " }) },
      expected: "123",
    },
    {
      name: "falls back to message.channel_id",
      params: { message: asMessage({ channel_id: " 234 " }) },
      expected: "234",
    },
    {
      name: "falls back to message.rawData.channel_id",
      params: { message: asMessage({ rawData: { channel_id: "456" } }) },
      expected: "456",
    },
    {
      name: "falls back to eventChannelId and coerces numeric values",
      params: { message: asMessage({}), eventChannelId: 789 },
      expected: "789",
    },
  ] as const)("$name", ({ params, expected }) => {
    expect(resolveDiscordMessageChannelId(params)).toBe(expected);
  });
});

describe("resolveForwardedMediaList", () => {
  beforeEach(() => {
    fetchRemoteMedia.mockClear();
    saveMediaBuffer.mockClear();
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
      maxBytes: 512,
      fetchImpl: undefined,
      ssrfPolicy: expect.objectContaining({ allowRfc2544BenchmarkRange: true }),
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

  it("forwards fetchImpl to forwarded attachment downloads", async () => {
    const proxyFetch = vi.fn() as unknown as typeof fetch;
    const attachment = {
      id: "att-proxy",
      url: "https://cdn.discordapp.com/attachments/1/proxy.png",
      filename: "proxy.png",
      content_type: "image/png",
    };
    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("image"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/proxy.png",
      contentType: "image/png",
    });

    await resolveForwardedMediaList(
      asMessage({
        rawData: {
          message_snapshots: [{ message: { attachments: [attachment] } }],
        },
      }),
      512,
      proxyFetch,
    );

    expect(fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({ fetchImpl: proxyFetch }),
    );
  });

  it("keeps forwarded attachment metadata when download fails", async () => {
    const attachment = {
      id: "att-fallback",
      url: "https://cdn.discordapp.com/attachments/1/fallback.png",
      filename: "fallback.png",
      content_type: "image/png",
    };
    fetchRemoteMedia.mockRejectedValueOnce(new Error("blocked by ssrf guard"));

    const result = await resolveForwardedMediaList(
      asMessage({
        rawData: {
          message_snapshots: [{ message: { attachments: [attachment] } }],
        },
      }),
      512,
    );

    expect(saveMediaBuffer).not.toHaveBeenCalled();
    expect(result).toEqual([
      {
        path: attachment.url,
        contentType: "image/png",
        placeholder: "<media:image>",
      },
    ]);
  });

  it("downloads forwarded stickers", async () => {
    const sticker = {
      id: "sticker-1",
      name: "wave",
      format_type: StickerFormatType.PNG,
    };
    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("sticker"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/sticker.png",
      contentType: "image/png",
    });

    const result = await resolveForwardedMediaList(
      asMessage({
        rawData: {
          message_snapshots: [{ message: { sticker_items: [sticker] } }],
        },
      }),
      512,
    );

    expect(fetchRemoteMedia).toHaveBeenCalledTimes(1);
    expect(fetchRemoteMedia).toHaveBeenCalledWith({
      url: "https://media.discordapp.net/stickers/sticker-1.png",
      filePathHint: "wave.png",
      maxBytes: 512,
      fetchImpl: undefined,
      ssrfPolicy: expect.objectContaining({ allowRfc2544BenchmarkRange: true }),
    });
    expect(saveMediaBuffer).toHaveBeenCalledTimes(1);
    expect(saveMediaBuffer).toHaveBeenCalledWith(expect.any(Buffer), "image/png", "inbound", 512);
    expect(result).toEqual([
      {
        path: "/tmp/sticker.png",
        contentType: "image/png",
        placeholder: "<media:sticker>",
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

describe("resolveMediaList", () => {
  beforeEach(() => {
    fetchRemoteMedia.mockClear();
    saveMediaBuffer.mockClear();
  });

  it("downloads stickers", async () => {
    const sticker = {
      id: "sticker-2",
      name: "hello",
      format_type: StickerFormatType.PNG,
    };
    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("sticker"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/sticker-2.png",
      contentType: "image/png",
    });

    const result = await resolveMediaList(
      asMessage({
        stickers: [sticker],
      }),
      512,
    );

    expect(fetchRemoteMedia).toHaveBeenCalledTimes(1);
    expect(fetchRemoteMedia).toHaveBeenCalledWith({
      url: "https://media.discordapp.net/stickers/sticker-2.png",
      filePathHint: "hello.png",
      maxBytes: 512,
      fetchImpl: undefined,
      ssrfPolicy: expect.objectContaining({ allowRfc2544BenchmarkRange: true }),
    });
    expect(saveMediaBuffer).toHaveBeenCalledTimes(1);
    expect(saveMediaBuffer).toHaveBeenCalledWith(expect.any(Buffer), "image/png", "inbound", 512);
    expect(result).toEqual([
      {
        path: "/tmp/sticker-2.png",
        contentType: "image/png",
        placeholder: "<media:sticker>",
      },
    ]);
  });

  it("forwards fetchImpl to sticker downloads", async () => {
    const proxyFetch = vi.fn() as unknown as typeof fetch;
    const sticker = {
      id: "sticker-proxy",
      name: "proxy-sticker",
      format_type: StickerFormatType.PNG,
    };
    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("sticker"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/sticker-proxy.png",
      contentType: "image/png",
    });

    await resolveMediaList(
      asMessage({
        stickers: [sticker],
      }),
      512,
      proxyFetch,
    );

    expect(fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({ fetchImpl: proxyFetch }),
    );
  });

  it("keeps attachment metadata when download fails", async () => {
    const attachment = {
      id: "att-main-fallback",
      url: "https://cdn.discordapp.com/attachments/1/main-fallback.png",
      filename: "main-fallback.png",
      content_type: "image/png",
    };
    fetchRemoteMedia.mockRejectedValueOnce(new Error("blocked by ssrf guard"));

    const result = await resolveMediaList(
      asMessage({
        attachments: [attachment],
      }),
      512,
    );

    expect(saveMediaBuffer).not.toHaveBeenCalled();
    expect(result).toEqual([
      {
        path: attachment.url,
        contentType: "image/png",
        placeholder: "<media:image>",
      },
    ]);
  });

  it("falls back to URL when saveMediaBuffer fails", async () => {
    const attachment = {
      id: "att-save-fail",
      url: "https://cdn.discordapp.com/attachments/1/photo.png",
      filename: "photo.png",
      content_type: "image/png",
    };
    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("image"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockRejectedValueOnce(new Error("disk full"));

    const result = await resolveMediaList(
      asMessage({
        attachments: [attachment],
      }),
      512,
    );

    expect(fetchRemoteMedia).toHaveBeenCalledTimes(1);
    expect(saveMediaBuffer).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      {
        path: attachment.url,
        contentType: "image/png",
        placeholder: "<media:image>",
      },
    ]);
  });

  it("preserves downloaded attachments alongside failed ones", async () => {
    const goodAttachment = {
      id: "att-good",
      url: "https://cdn.discordapp.com/attachments/1/good.png",
      filename: "good.png",
      content_type: "image/png",
    };
    const badAttachment = {
      id: "att-bad",
      url: "https://cdn.discordapp.com/attachments/1/bad.pdf",
      filename: "bad.pdf",
      content_type: "application/pdf",
    };

    fetchRemoteMedia
      .mockResolvedValueOnce({
        buffer: Buffer.from("image"),
        contentType: "image/png",
      })
      .mockRejectedValueOnce(new Error("network timeout"));
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/good.png",
      contentType: "image/png",
    });

    const result = await resolveMediaList(
      asMessage({
        attachments: [goodAttachment, badAttachment],
      }),
      512,
    );

    expect(result).toEqual([
      {
        path: "/tmp/good.png",
        contentType: "image/png",
        placeholder: "<media:image>",
      },
      {
        path: badAttachment.url,
        contentType: "application/pdf",
        placeholder: "<media:document>",
      },
    ]);
  });

  it("keeps sticker metadata when sticker download fails", async () => {
    const sticker = {
      id: "sticker-fallback",
      name: "fallback",
      format_type: StickerFormatType.PNG,
    };
    fetchRemoteMedia.mockRejectedValueOnce(new Error("blocked by ssrf guard"));

    const result = await resolveMediaList(
      asMessage({
        stickers: [sticker],
      }),
      512,
    );

    expect(saveMediaBuffer).not.toHaveBeenCalled();
    expect(result).toEqual([
      {
        path: "https://media.discordapp.net/stickers/sticker-fallback.png",
        contentType: "image/png",
        placeholder: "<media:sticker>",
      },
    ]);
  });
});

describe("Discord media SSRF policy", () => {
  beforeEach(() => {
    fetchRemoteMedia.mockClear();
    saveMediaBuffer.mockClear();
  });

  it("passes ssrfPolicy with Discord CDN allowedHostnames and allowRfc2544BenchmarkRange", async () => {
    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("img"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/a.png",
      contentType: "image/png",
    });

    await resolveMediaList(
      asMessage({
        attachments: [{ id: "a1", url: "https://cdn.discordapp.com/a.png", filename: "a.png" }],
      }),
      1024,
    );

    const policy = fetchRemoteMedia.mock.calls[0][0].ssrfPolicy;
    expect(policy).toEqual({
      allowedHostnames: ["cdn.discordapp.com", "media.discordapp.net"],
      allowRfc2544BenchmarkRange: true,
    });
  });
});

describe("resolveDiscordMessageText", () => {
  it("includes forwarded message snapshots in body text", () => {
    const text = resolveDiscordMessageText(
      asMessage({
        content: "",
        rawData: {
          message_snapshots: [
            {
              message: {
                content: "forwarded hello",
                embeds: [],
                attachments: [],
                author: {
                  id: "u2",
                  username: "Bob",
                  discriminator: "0",
                },
              },
            },
          ],
        },
      }),
      { includeForwarded: true },
    );

    expect(text).toContain("[Forwarded message from @Bob]");
    expect(text).toContain("forwarded hello");
  });

  it("uses sticker placeholders when content is empty", () => {
    const text = resolveDiscordMessageText(
      asMessage({
        content: "",
        stickers: [
          {
            id: "sticker-3",
            name: "party",
            format_type: StickerFormatType.PNG,
          },
        ],
      }),
    );

    expect(text).toBe("<media:sticker> (1 sticker)");
  });

  it("uses embed title when content is empty", () => {
    const text = resolveDiscordMessageText(
      asMessage({
        content: "",
        embeds: [{ title: "Breaking" }],
      }),
    );

    expect(text).toBe("Breaking");
  });

  it("uses embed description when content is empty", () => {
    const text = resolveDiscordMessageText(
      asMessage({
        content: "",
        embeds: [{ description: "Details" }],
      }),
    );

    expect(text).toBe("Details");
  });

  it("joins embed title and description when content is empty", () => {
    const text = resolveDiscordMessageText(
      asMessage({
        content: "",
        embeds: [{ title: "Breaking", description: "Details" }],
      }),
    );

    expect(text).toBe("Breaking\nDetails");
  });

  it("prefers message content over embed fallback text", () => {
    const text = resolveDiscordMessageText(
      asMessage({
        content: "hello from content",
        embeds: [{ title: "Breaking", description: "Details" }],
      }),
    );

    expect(text).toBe("hello from content");
  });

  it("joins forwarded snapshot embed title and description when content is empty", () => {
    const text = resolveDiscordMessageText(
      asMessage({
        content: "",
        rawData: {
          message_snapshots: [
            {
              message: {
                content: "",
                embeds: [{ title: "Forwarded title", description: "Forwarded details" }],
                attachments: [],
                author: {
                  id: "u2",
                  username: "Bob",
                  discriminator: "0",
                },
              },
            },
          ],
        },
      }),
      { includeForwarded: true },
    );

    expect(text).toContain("[Forwarded message from @Bob]");
    expect(text).toContain("Forwarded title\nForwarded details");
  });
});

describe("resolveDiscordChannelInfo", () => {
  beforeEach(() => {
    __resetDiscordChannelInfoCacheForTest();
  });

  it("caches channel lookups between calls", async () => {
    const fetchChannel = vi.fn().mockResolvedValue({
      type: ChannelType.DM,
      name: "dm",
    });
    const client = { fetchChannel } as unknown as Client;

    const first = await resolveDiscordChannelInfo(client, "cache-channel-1");
    const second = await resolveDiscordChannelInfo(client, "cache-channel-1");

    expect(first).toEqual({
      type: ChannelType.DM,
      name: "dm",
      topic: undefined,
      parentId: undefined,
      ownerId: undefined,
    });
    expect(second).toEqual(first);
    expect(fetchChannel).toHaveBeenCalledTimes(1);
  });

  it("negative-caches missing channels", async () => {
    const fetchChannel = vi.fn().mockResolvedValue(null);
    const client = { fetchChannel } as unknown as Client;

    const first = await resolveDiscordChannelInfo(client, "missing-channel");
    const second = await resolveDiscordChannelInfo(client, "missing-channel");

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(fetchChannel).toHaveBeenCalledTimes(1);
  });
});
