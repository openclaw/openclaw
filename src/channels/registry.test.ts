import { describe, expect, it } from "vitest";
import {
  formatChannelSelectionLine,
  listChatChannels,
  normalizeChatChannelId,
} from "./registry.js";

describe("channel registry", () => {
  it("normalizes aliases", () => {
    expect(normalizeChatChannelId("imsg")).toBe("imessage");
    expect(normalizeChatChannelId("gchat")).toBe("googlechat");
    expect(normalizeChatChannelId("google-chat")).toBe("googlechat");
    expect(normalizeChatChannelId("internet-relay-chat")).toBe("irc");
    expect(normalizeChatChannelId("web")).toBeNull();
  });

  it("keeps Telegram first in the default order", () => {
    const channels = listChatChannels();
    expect(channels[0]?.id).toBe("telegram");
  });

  it("does not include MS Teams by default", () => {
    const channels = listChatChannels();
    expect(channels.some((channel) => channel.id === "msteams")).toBe(false);
  });

  it("does not include Signal by default", () => {
    const channels = listChatChannels();
    expect(channels.some((channel) => channel.id === "signal")).toBe(false);
  });

  it("formats selection lines with docs labels", () => {
    const channels = listChatChannels();
    const first = channels[0];
    if (!first) {
      throw new Error("Missing channel metadata.");
    }
    const line = formatChannelSelectionLine(first, (path, label) =>
      [label, path].filter(Boolean).join(":"),
    );
    expect(line).not.toContain("Docs:");
    expect(line).toContain("/channels/telegram");
    expect(line).toContain("https://openclaw.ai");
  });

  it("formats selection lines when docsPath is missing", () => {
    const line = formatChannelSelectionLine(
      {
        id: "example",
        label: "Example",
        selectionLabel: "Example",
        // Runtime plugin metadata may omit docsPath; formatting should stay resilient.
        docsPath: "" as unknown as string,
        blurb: "desc",
      },
      (path, label) => [label, path].filter(Boolean).join(":"),
    );
    expect(line).toContain("/channels");
  });
});
