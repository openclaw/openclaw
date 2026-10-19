import { describe, expect, it } from "vitest";
import { createRfbClientMessageFilter } from "./rfb-view-only-filter.js";

const VERSION = Buffer.from("RFB 003.008\n", "ascii");

function noneHandshake(): Buffer {
  return Buffer.concat([VERSION, Buffer.from([1, 1])]);
}

function vncAuthHandshake(): Buffer {
  return Buffer.concat([
    VERSION,
    Buffer.from([2]),
    Buffer.from(Array.from({ length: 16 }, (_, index) => index)),
    Buffer.from([1]),
  ]);
}

function enterMessagePhase() {
  const filter = createRfbClientMessageFilter();
  expect(filter.filter(noneHandshake())).toEqual({ forward: noneHandshake() });
  return filter;
}

describe("RFB view-only client message filter", () => {
  it.each([["VncAuth", vncAuthHandshake()]])(
    "forwards a complete %s handshake byte-identically",
    (_name, handshake) => {
      const filter = createRfbClientMessageFilter();
      expect(filter.filter(handshake)).toEqual({ forward: handshake });
    },
  );

  it("rewrites an exclusive ClientInit batched with the following message", () => {
    const filter = createRfbClientMessageFilter();
    const prefix = Buffer.concat([VERSION, Buffer.from([1])]);
    const framebufferRequest = Buffer.from([3, 1, 0, 0, 0, 0, 0, 64, 0, 64]);
    expect(filter.filter(prefix)).toEqual({ forward: prefix });
    expect(filter.filter(Buffer.concat([Buffer.from([0]), framebufferRequest]))).toEqual({
      forward: Buffer.concat([Buffer.from([1]), framebufferRequest]),
    });
  });

  it("starts at ClientInit after server-side authentication without forwarding input", () => {
    const filter = createRfbClientMessageFilter({ startPhase: "clientInit" });
    const keyEvent = Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]);
    const framebufferRequest = Buffer.from([3, 1, 0, 0, 0, 0, 0, 64, 0, 64]);

    expect(filter.filter(Buffer.concat([Buffer.from([0]), keyEvent, framebufferRequest]))).toEqual({
      forward: Buffer.concat([Buffer.from([1]), framebufferRequest]),
    });
  });

  it.each([30])("fails closed on unsupported security type %s", (securityType) => {
    const filter = createRfbClientMessageFilter();
    expect(filter.filter(Buffer.concat([VERSION, Buffer.from([securityType])]))).toEqual({
      error: `unsupported RFB security type ${securityType}`,
    });
  });

  it("drops input messages while forwarding display configuration and update requests", () => {
    const filter = enterMessagePhase();
    const setPixelFormat = Buffer.alloc(20);
    setPixelFormat[0] = 0;
    const setEncodings = Buffer.alloc(8);
    setEncodings[0] = 2;
    setEncodings.writeUInt16BE(1, 2);
    setEncodings.writeInt32BE(0, 4);
    const framebufferUpdateRequest = Buffer.from([3, 1, 0, 0, 0, 0, 0, 64, 0, 64]);
    const keyEvent = Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]);
    const pointerEvent = Buffer.from([5, 1, 0, 10, 0, 20]);
    const extendedPointerEvent = Buffer.from([5, 0x80, 0, 10, 0, 20, 1]);
    const cutText = Buffer.concat([Buffer.from([6, 0, 0, 0, 0, 0, 0, 3]), Buffer.from("abc")]);
    const setDesktopSize = Buffer.alloc(24);
    setDesktopSize[0] = 251;
    const extendedKeyEvent = Buffer.alloc(12);
    extendedKeyEvent[0] = 255;

    const result = filter.filter(
      Buffer.concat([
        keyEvent,
        setPixelFormat,
        pointerEvent,
        extendedPointerEvent,
        setEncodings,
        cutText,
        setDesktopSize,
        extendedKeyEvent,
        framebufferUpdateRequest,
      ]),
    );

    expect(result).toEqual({
      forward: Buffer.concat([setPixelFormat, setEncodings, framebufferUpdateRequest]),
    });
  });

  it("forwards the fragmented noVNC 1.7 display and flow-control sequence", () => {
    const filter = enterMessagePhase();
    const setPixelFormat = Buffer.alloc(20);
    const setEncodings = Buffer.alloc(100);
    setEncodings[0] = 2;
    setEncodings.writeUInt16BE(24, 2);
    const framebufferUpdateRequest = Buffer.from([3, 1, 0, 0, 0, 0, 0, 64, 0, 64]);
    const clientFence = Buffer.from([248, 0, 0, 0, 0, 0, 0, 0, 1, 0]);
    const enableContinuousUpdates = Buffer.from([150, 1, 0, 0, 0, 0, 0, 64, 0, 64]);
    const cutText = Buffer.alloc(16);
    cutText[0] = 6;
    cutText.writeInt32BE(-8, 4);
    const capturedSequence = Buffer.concat([
      setPixelFormat,
      setEncodings,
      framebufferUpdateRequest,
      clientFence,
      enableContinuousUpdates,
      cutText,
      enableContinuousUpdates,
    ]);
    const forwarded: Buffer[] = [];

    for (const byte of capturedSequence) {
      const result = filter.filter(Buffer.of(byte));
      if ("error" in result) {
        throw new Error(result.error);
      }
      forwarded.push(result.forward);
    }

    expect(Buffer.concat(forwarded)).toEqual(
      Buffer.concat([
        setPixelFormat,
        setEncodings,
        framebufferUpdateRequest,
        clientFence,
        enableContinuousUpdates,
        enableContinuousUpdates,
      ]),
    );
  });

  it("fails closed on unknown message types", () => {
    const filter = enterMessagePhase();
    expect(filter.filter(Buffer.from([254]))).toEqual({
      error: "unsupported RFB client message type 254",
    });
  });

  it("fails closed before buffering an oversized variable-length message", () => {
    const filter = enterMessagePhase();
    const header = Buffer.alloc(8);
    header[0] = 6;
    header.writeUInt32BE(64 * 1024, 4);
    expect(filter.filter(header)).toEqual({
      error: "RFB client message exceeds the 64 KiB buffer limit",
    });
  });
});
