import { afterEach, describe, expect, it, vi } from "vitest";

describe("chat-meta import", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("loads bundled chat metadata at import time", async () => {
    const chatMeta = await import("./chat-meta.js");

    expect(chatMeta.listChatChannels().map((entry) => entry.id)).toEqual([
      "telegram",
      "whatsapp",
      "discord",
      "irc",
      "googlechat",
      "slack",
      "signal",
      "imessage",
      "line",
    ]);
  });
});
