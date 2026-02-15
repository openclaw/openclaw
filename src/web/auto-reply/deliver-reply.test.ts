import { describe, expect, it, vi } from "vitest";
import type { WebInboundMsg } from "./types.js";
import { deliverWebReply } from "./deliver-reply.js";

vi.mock("../media.js", () => ({
  loadWebMedia: vi.fn(),
}));

vi.mock("../../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils.js")>();
  return {
    ...actual,
    sleep: vi.fn(async () => {}),
  };
});

const { loadWebMedia } = await import("../media.js");

function makeMsg(): WebInboundMsg {
  return {
    from: "+10000000000",
    to: "+20000000000",
    id: "msg-1",
    reply: vi.fn(async () => undefined),
    sendMedia: vi.fn(async () => undefined),
  } as unknown as WebInboundMsg;
}

const replyLogger = {
  info: vi.fn(),
  warn: vi.fn(),
};

describe("deliverWebReply", () => {
  it("sends chunked text replies and logs a summary", async () => {
    const msg = makeMsg();

    await deliverWebReply({
      replyResult: { text: "aaaaaa" },
      msg,
      maxMediaBytes: 1024 * 1024,
      textLimit: 3,
      replyLogger,
      skipLog: true,
    });

    expect(msg.reply).toHaveBeenCalledTimes(2);
    expect(msg.reply).toHaveBeenNthCalledWith(1, "aaa");
    expect(msg.reply).toHaveBeenNthCalledWith(2, "aaa");
    expect(replyLogger.info).toHaveBeenCalledWith(expect.any(Object), "auto-reply sent (text)");
  });

  it("sends image media with caption and then remaining text", async () => {
    const msg = makeMsg();
    (
      loadWebMedia as unknown as { mockResolvedValueOnce: (v: unknown) => void }
    ).mockResolvedValueOnce({
      buffer: Buffer.from("img"),
      contentType: "image/jpeg",
      kind: "image",
    });

    await deliverWebReply({
      replyResult: { text: "aaaaaa", mediaUrl: "http://example.com/img.jpg" },
      msg,
      maxMediaBytes: 1024 * 1024,
      textLimit: 3,
      replyLogger,
      skipLog: true,
    });

    expect(msg.sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        image: expect.any(Buffer),
        caption: "aaa",
        mimetype: "image/jpeg",
      }),
    );
    expect(msg.reply).toHaveBeenCalledWith("aaa");
    expect(replyLogger.info).toHaveBeenCalledWith(expect.any(Object), "auto-reply sent (media)");
  });

  it("falls back to text-only when the first media send fails", async () => {
    const msg = makeMsg();
    (
      loadWebMedia as unknown as { mockResolvedValueOnce: (v: unknown) => void }
    ).mockResolvedValueOnce({
      buffer: Buffer.from("img"),
      contentType: "image/jpeg",
      kind: "image",
    });
    (
      msg.sendMedia as unknown as { mockRejectedValueOnce: (v: unknown) => void }
    ).mockRejectedValueOnce(new Error("boom"));

    await deliverWebReply({
      replyResult: { text: "caption", mediaUrl: "http://example.com/img.jpg" },
      msg,
      maxMediaBytes: 1024 * 1024,
      textLimit: 20,
      replyLogger,
      skipLog: true,
    });

    expect(msg.reply).toHaveBeenCalledTimes(1);
    expect(
      String((msg.reply as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0]),
    ).toContain("⚠️ Media failed");
    expect(replyLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ mediaUrl: "http://example.com/img.jpg" }),
      "failed to send web media reply",
    );
  });
});
