// Channel id tests cover identifier normalization and validation helpers.
import { describe, expect, it, vi } from "vitest";
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
    ["imessage", "iMessage"],
    ["googlechat", "Google Chat"],
    [" imsg ", "iMessage"],
    ["GOOGLE-CHAT", "Google Chat"],
  ])("finds the exact generated label for %s", (channel, label) => {
    expect(findChatChannelLabel(channel)).toBe(label);
  });

  it("does not fall back to runtime metadata for unknown channels", () => {
    expect(findChatChannelLabel("external-chat")).toBeUndefined();
    expect(findChatChannelLabel(" ")).toBeUndefined();
  });
});
