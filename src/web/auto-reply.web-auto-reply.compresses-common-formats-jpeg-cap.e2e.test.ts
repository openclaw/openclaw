import crypto from "node:crypto";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { monitorWebChannel } from "./auto-reply.js";
import {
  installWebAutoReplyTestHomeHooks,
  installWebAutoReplyUnitTestHooks,
  resetLoadConfigMock,
  setLoadConfigMock,
} from "./auto-reply.test-harness.js";

installWebAutoReplyTestHomeHooks();

describe("web auto-reply", () => {
  installWebAutoReplyUnitTestHooks({ pinDns: true });

  it("compresses common formats to jpeg under the cap", { timeout: 45_000 }, async () => {
    const formats = [
      {
        name: "png",
        mime: "image/png",
        make: (buf: Buffer, opts: { width: number; height: number }) =>
          sharp(buf, {
            raw: { width: opts.width, height: opts.height, channels: 3 },
          })
            .png({ compressionLevel: 0 })
            .toBuffer(),
      },
      {
        name: "jpeg",
        mime: "image/jpeg",
        make: (buf: Buffer, opts: { width: number; height: number }) =>
          sharp(buf, {
            raw: { width: opts.width, height: opts.height, channels: 3 },
          })
            .jpeg({ quality: 90 })
            .toBuffer(),
      },
      {
        name: "webp",
        mime: "image/webp",
        make: (buf: Buffer, opts: { width: number; height: number }) =>
          sharp(buf, {
            raw: { width: opts.width, height: opts.height, channels: 3 },
          })
            .webp({ quality: 100 })
            .toBuffer(),
      },
    ] as const;

    const width = 1200;
    const height = 1200;
    const sharedRaw = crypto.randomBytes(width * height * 3);

    for (const fmt of formats) {
      // Force a small cap to ensure compression is exercised for every format.
      setLoadConfigMock(() => ({ agents: { defaults: { mediaMaxMb: 1 } } }));
      const sendMedia = vi.fn();
      const reply = vi.fn().mockResolvedValue(undefined);
      const sendComposing = vi.fn();
      const resolver = vi.fn().mockResolvedValue({
        text: "hi",
        mediaUrl: `https://example.com/big.${fmt.name}`,
      });

      let capturedOnMessage:
        | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
        | undefined;
      const listenerFactory = async (opts: {
        onMessage: (msg: import("./inbound.js").WebInboundMessage) => Promise<void>;
      }) => {
        capturedOnMessage = opts.onMessage;
        return { close: vi.fn() };
      };

      const big = await fmt.make(sharedRaw, { width, height });
      expect(big.length).toBeGreaterThan(1 * 1024 * 1024);

      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        body: true,
        arrayBuffer: async () => big.buffer.slice(big.byteOffset, big.byteOffset + big.byteLength),
        headers: { get: () => fmt.mime },
        status: 200,
      } as Response);

      await monitorWebChannel(false, listenerFactory, false, resolver);
      expect(capturedOnMessage).toBeDefined();

      await capturedOnMessage?.({
        body: "hello",
        from: "+1",
        to: "+2",
        id: `msg-${fmt.name}`,
        sendComposing,
        reply,
        sendMedia,
      });

      expect(sendMedia).toHaveBeenCalledTimes(1);
      const payload = sendMedia.mock.calls[0][0] as {
        image: Buffer;
        mimetype?: string;
      };
      expect(payload.image.length).toBeLessThanOrEqual(1 * 1024 * 1024);
      expect(payload.mimetype).toBe("image/jpeg");
      expect(reply).not.toHaveBeenCalled();

      fetchMock.mockRestore();
      resetLoadConfigMock();
    }
  });

  it("honors mediaMaxMb from config", async () => {
    setLoadConfigMock(() => ({ agents: { defaults: { mediaMaxMb: 1 } } }));
    const sendMedia = vi.fn();
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn();
    const resolver = vi.fn().mockResolvedValue({
      text: "hi",
      mediaUrl: "https://example.com/big.png",
    });

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const listenerFactory = async (opts: {
      onMessage: (msg: import("./inbound.js").WebInboundMessage) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    const bigPng = await sharp({
      create: {
        width: 1800,
        height: 1800,
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
    } as Response);

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "hello",
      from: "+1",
      to: "+2",
      id: "msg1",
      sendComposing,
      reply,
      sendMedia,
    });

    expect(sendMedia).toHaveBeenCalledTimes(1);
    const payload = sendMedia.mock.calls[0][0] as {
      image: Buffer;
      caption?: string;
      mimetype?: string;
    };
    expect(payload.image.length).toBeLessThanOrEqual(1 * 1024 * 1024);
    expect(payload.mimetype).toBe("image/jpeg");
    expect(reply).not.toHaveBeenCalled();

    fetchMock.mockRestore();
  });
  it("falls back to text when media is unsupported", async () => {
    const sendMedia = vi.fn();
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn();
    const resolver = vi.fn().mockResolvedValue({
      text: "hi",
      mediaUrl: "https://example.com/file.pdf",
    });

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const listenerFactory = async (opts: {
      onMessage: (msg: import("./inbound.js").WebInboundMessage) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      body: true,
      arrayBuffer: async () => Buffer.from("%PDF-1.4").buffer,
      headers: { get: () => "application/pdf" },
      status: 200,
    } as Response);

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "hello",
      from: "+1",
      to: "+2",
      id: "msg-pdf",
      sendComposing,
      reply,
      sendMedia,
    });

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
});
