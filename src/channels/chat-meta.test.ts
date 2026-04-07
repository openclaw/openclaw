import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAT_CHANNEL_ORDER } from "./ids.js";

describe("chat-meta import", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("loads bundled chat metadata at import time", async () => {
    const chatMeta = await import("./chat-meta.js");

    expect(chatMeta.listChatChannels().map((entry) => entry.id)).toEqual(CHAT_CHANNEL_ORDER);
  });
});
