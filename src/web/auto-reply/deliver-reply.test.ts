import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebInboundMsg } from "./types.js";
import { deliverWebReply } from "./deliver-reply.js";

vi.mock("../media.js", () => ({
  loadWebMedia: vi.fn(),
}));

const { loadWebMedia } = await import("../media.js");

const makeMsg = (overrides: Partial<WebInboundMsg> = {}): WebInboundMsg =>
  ({
    id: "m1",
    from: "+10000000000",
    conversationId: "c1",
    to: "+20000000000",
    accountId: "default",
    body: "",
    chatType: "direct",
    chatId: "c1",
    sendComposing: async () => {},
    reply: vi.fn(async () => undefined),
    sendMedia: vi.fn(async () => undefined),
    ...overrides,
  }) as unknown as WebInboundMsg;

const replyLogger = {
  info: vi.fn(),
  warn: vi.fn(),
};

describe("deliverWebReply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("strips internal tool-error banners from WhatsApp outbound text", async () => {
    const msg = makeMsg();

    await deliverWebReply({
      replyResult: {
        text: "⚠️ 🛠️ Exec: set -euo pipefail failed: Command exited with code 1\nReal message line 1\n\nReal message line 2",
      },
      msg,
      maxMediaBytes: 1024 * 1024,
      textLimit: 5000,
      replyLogger,
      skipLog: true,
    });

    expect(msg.reply).toHaveBeenCalledTimes(1);
    expect(msg.reply).toHaveBeenCalledWith("Real message line 1\n\nReal message line 2");
  });

  it("skips invalid mediaUrl candidates (placeholders) and sends caption only", async () => {
    const msg = makeMsg();

    await deliverWebReply({
      replyResult: { text: "caption", mediaUrl: "image" },
      msg,
      maxMediaBytes: 1024 * 1024,
      textLimit: 5000,
      replyLogger,
      skipLog: true,
    });

    expect(loadWebMedia).not.toHaveBeenCalled();
    expect(msg.sendMedia).not.toHaveBeenCalled();
    expect(msg.reply).toHaveBeenCalledTimes(1);
    expect(msg.reply).toHaveBeenCalledWith("caption");
  });
});
