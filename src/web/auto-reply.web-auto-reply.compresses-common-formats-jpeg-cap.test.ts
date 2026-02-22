import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { monitorWebChannel } from "./auto-reply.js";
import {
  createMockWebListener,
  installWebAutoReplyTestHomeHooks,
  installWebAutoReplyUnitTestHooks,
  resetLoadConfigMock,
  setLoadConfigMock,
} from "./auto-reply.test-harness.js";
import type { WebInboundMessage } from "./inbound.js";

installWebAutoReplyTestHomeHooks();

describe("web auto-reply", () => {
  installWebAutoReplyUnitTestHooks({ pinDns: true });
  type ListenerFactory = NonNullable<Parameters<typeof monitorWebChannel>[1]>;

  async function setupSingleInboundMessage(params: {
    resolverValue: { text: string; mediaUrl: string };
    sendMedia: ReturnType<typeof vi.fn>;
    reply?: ReturnType<typeof vi.fn>;
  }) {
    const reply = params.reply ?? vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn(async () => undefined);
    const resolver = vi.fn().mockResolvedValue(params.resolverValue);

    let capturedOnMessage: ((msg: WebInboundMessage) => Promise<void>) | undefined;
    const listenerFactory: ListenerFactory = async ({ onMessage }) => {
      capturedOnMessage = onMessage;
      return createMockWebListener();
    };

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    return {
      reply,
      dispatch: async (id = "msg1") => {
        await capturedOnMessage?.({
          body: "hello",
          from: "+1",
          conversationId: "+1",
          to: "+2",
          accountId: "default",
          chatType: "direct",
          chatId: "+1",
          id,
          sendComposing,
          reply,
          sendMedia: params.sendMedia,
        } as WebInboundMessage);
      },
    };
  }

  function getSingleImagePayload(sendMedia: ReturnType<typeof vi.fn>) {
    expect(sendMedia).toHaveBeenCalledTimes(1);
    return sendMedia.mock.calls[0][0] as {
      image: Buffer;
      caption?: string;
      mimetype?: string;
    };
  }

  it("honors mediaMaxMb from config", async () => {
    setLoadConfigMock(() => ({ agents: { defaults: { mediaMaxMb: 1 } } }));
    const sendMedia = vi.fn();
    const { reply, dispatch } = await setupSingleInboundMessage({
      resolverValue: {
        text: "hi",
        mediaUrl: "https://example.com/big.png",
      },
      sendMedia,
    });

    const bigPng = await sharp({
      create: {
        width: 900,
        height: 900,
        channels: 3,
        background: { r: 0, g: 0, b: 255 },
      },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    expect(bigPng.length).toBeGreaterThan(1 * 1024 * 1024);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      body: true,
      arrayBuffer: async () =>
        bigPng.buffer.slice(bigPng.byteOffset, bigPng.byteOffset + bigPng.byteLength),
      headers: { get: () => "image/png" },
      status: 200,
    } as unknown as Response);

    await dispatch("msg-big");

    const payload = getSingleImagePayload(sendMedia);
    expect(payload.image.length).toBeLessThanOrEqual(1 * 1024 * 1024);
    expect(payload.mimetype).toBe("image/jpeg");
    expect(reply).not.toHaveBeenCalled();

    fetchMock.mockRestore();
    resetLoadConfigMock();
  });
  it("falls back to text when media is unsupported", async () => {
    const sendMedia = vi.fn();
    const { reply, dispatch } = await setupSingleInboundMessage({
      resolverValue: { text: "hi", mediaUrl: "https://example.com/file.pdf" },
      sendMedia,
    });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      body: true,
      arrayBuffer: async () => Buffer.from("%PDF-1.4").buffer,
      headers: { get: () => "application/pdf" },
      status: 200,
    } as unknown as Response);

    await dispatch("msg-pdf");

    expect(sendMedia).toHaveBeenCalledTimes(1);
    const payload = sendMedia.mock.calls[0][0] as {
      document?: Buffer;
      caption?: string;
      fileName?: string;
    };
    expect(payload.document).toBeInstanceOf(Buffer);
    expect(payload.fileName).toBe("file.pdf");
    expect(payload.caption).toBe("hi");
    expect(reply).not.toHaveBeenCalled();

    fetchMock.mockRestore();
  });

  it("falls back to text when media send fails", async () => {
    const sendMedia = vi.fn().mockRejectedValue(new Error("boom"));
    const { reply, dispatch } = await setupSingleInboundMessage({
      resolverValue: {
        text: "hi",
        mediaUrl: "https://example.com/img.png",
      },
      sendMedia,
    });

    const smallPng = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 3,
        background: { r: 0, g: 255, b: 0 },
      },
    })
      .png()
      .toBuffer();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      body: true,
      arrayBuffer: async () =>
        smallPng.buffer.slice(smallPng.byteOffset, smallPng.byteOffset + smallPng.byteLength),
      headers: { get: () => "image/png" },
      status: 200,
    } as unknown as Response);

    await dispatch("msg1");

    expect(sendMedia).toHaveBeenCalledTimes(1);
    const fallback = reply.mock.calls[0]?.[0] as string;
    expect(fallback).toContain("hi");
    expect(fallback).toContain("Media failed");
    fetchMock.mockRestore();
  });
  it("returns a warning when remote media fetch 404s", async () => {
    const sendMedia = vi.fn();
    const { reply, dispatch } = await setupSingleInboundMessage({
      resolverValue: {
        text: "caption",
        mediaUrl: "https://example.com/missing.jpg",
      },
      sendMedia,
    });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 404,
      body: null,
      arrayBuffer: async () => new ArrayBuffer(0),
      headers: { get: () => "text/plain" },
    } as unknown as Response);

    await dispatch("msg1");

    expect(sendMedia).not.toHaveBeenCalled();
    const fallback = reply.mock.calls[0]?.[0] as string;
    expect(fallback).toContain("caption");
    expect(fallback).toContain("Media failed");
    expect(fallback).toContain("404");

    fetchMock.mockRestore();
  });
  it("sends media with a caption when delivery succeeds", async () => {
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const { reply, dispatch } = await setupSingleInboundMessage({
      resolverValue: {
        text: "hi",
        mediaUrl: "https://example.com/img.png",
      },
      sendMedia,
    });

    const png = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 3,
        background: { r: 0, g: 0, b: 255 },
      },
    })
      .png()
      .toBuffer();

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      body: true,
      arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
      headers: { get: () => "image/png" },
      status: 200,
    } as unknown as Response);

    await dispatch("msg1");

    const payload = getSingleImagePayload(sendMedia);
    expect(payload.caption).toBe("hi");
    expect(payload.image.length).toBeGreaterThan(0);
    // Should not fall back to separate text reply because caption is used.
    expect(reply).not.toHaveBeenCalled();

    fetchMock.mockRestore();
  });
});
