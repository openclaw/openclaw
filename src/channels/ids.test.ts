// Channel id tests cover identifier normalization and validation helpers.
import { describe, expect, it, vi } from "vitest";
import * as bundledChannelCatalog from "./bundled-channel-catalog-read.js";
import { findChatChannelLabel, normalizeChatChannelId } from "./ids.js";

vi.hoisted(() => {
  // Runtime setup can import channel IDs before this file's schema guard.
  vi.resetModules();
});

vi.mock("../config/bundled-channel-config-metadata.generated.js", () => {
  throw new Error("Channel ID normalization must not load channel configuration schemas");
});

describe("channel ids", () => {
  it("normalizes built-in aliases + trims whitespace", () => {
    expect(normalizeChatChannelId(" imsg ")).toBe("imessage");
    expect(normalizeChatChannelId("gchat")).toBe("googlechat");
    expect(normalizeChatChannelId("google-chat")).toBe("googlechat");
    expect(normalizeChatChannelId("internet-relay-chat")).toBe("irc");
    expect(normalizeChatChannelId("telegram")).toBe("telegram");
    expect(normalizeChatChannelId("web")).toBeNull();
    expect(normalizeChatChannelId("nope")).toBeNull();
  });

  it.each([
    ["whatsapp", "WhatsApp"],
    ["GOOGLE-CHAT", "Google Chat"],
  ])("finds the exact generated label for %s", (channel, label) => {
    expect(findChatChannelLabel(channel)).toBe(label);
  });

  it("does not fall back to runtime metadata for unknown channels", () => {
    const catalog = vi
      .spyOn(bundledChannelCatalog, "listBundledChannelCatalogEntries")
      .mockReturnValue([
        {
          id: "external-chat",
          aliases: [],
          order: 0,
          channel: { id: "external-chat", label: "External Chat" },
        },
      ]);
    try {
      expect(normalizeChatChannelId("external-chat")).toBe("external-chat");
      expect(findChatChannelLabel("external-chat")).toBeUndefined();
      expect(findChatChannelLabel(" ")).toBeUndefined();
    } finally {
      catalog.mockRestore();
    }
  });
});
