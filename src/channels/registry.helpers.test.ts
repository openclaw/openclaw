import { describe, expect, it } from "vitest";
import { formatChannelSelectionLine, listChatChannels } from "./registry.js";

describe("channel registry helpers", () => {
  it("keeps Feishu first in the current default order", () => {
    const channels = listChatChannels();
    expect(channels[0]?.id).toBe("feishu");
  });

  it("includes MS Teams in the bundled channel list", () => {
    const channels = listChatChannels();
    expect(channels.some((channel) => channel.id === "msteams")).toBe(true);
  });

  it("formats Telegram selection lines without a docs prefix and with website extras", () => {
    const telegram = listChatChannels().find((channel) => channel.id === "telegram");
    if (!telegram) {
      throw new Error("Missing Telegram channel metadata.");
    }
    const line = formatChannelSelectionLine(telegram, (path, label) =>
      [label, path].filter(Boolean).join(":"),
    );
    expect(line).not.toContain("Docs:");
    expect(line).toContain("/channels/telegram");
    expect(line).toContain("https://openclaw.ai");
  });
});
