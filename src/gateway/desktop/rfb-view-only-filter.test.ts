import { expect, it } from "vitest";
import { createRfbClientMessageFilter } from "./rfb-view-only-filter.js";

const VERSION = Buffer.from("RFB 003.008\n", "ascii");
const NONE_HANDSHAKE = Buffer.concat([VERSION, Buffer.from([1, 1])]);
const FRAMEBUFFER_REQUEST = Buffer.from([3, 1, 0, 0, 0, 0, 0, 64, 0, 64]);
const KEY_EVENT = Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]);
const PIXEL_FORMAT = Buffer.alloc(20);

function encodings(count: number) {
  const message = Buffer.alloc(4 + count * 4);
  message[0] = 2;
  message.writeUInt16BE(count, 2);
  return message;
}

function enterMessagePhase() {
  const filter = createRfbClientMessageFilter();
  expect(filter.filter(NONE_HANDSHAKE)).toEqual({ forward: NONE_HANDSHAKE });
  return filter;
}

it("forwards a complete VncAuth handshake byte-identically", () => {
  const handshake = Buffer.concat([
    VERSION,
    Buffer.of(2),
    Buffer.from(Array.from({ length: 16 }, (_, i) => i)),
    Buffer.of(1),
  ]);
  expect(createRfbClientMessageFilter().filter(handshake)).toEqual({ forward: handshake });
});

it("rewrites an exclusive ClientInit batched with the following message", () => {
  const filter = createRfbClientMessageFilter();
  const prefix = Buffer.concat([VERSION, Buffer.from([1])]);
  expect(filter.filter(prefix)).toEqual({ forward: prefix });
  expect(filter.filter(Buffer.concat([Buffer.from([0]), FRAMEBUFFER_REQUEST]))).toEqual({
    forward: Buffer.concat([Buffer.from([1]), FRAMEBUFFER_REQUEST]),
  });
});

it("starts at ClientInit after server-side authentication without forwarding input", () => {
  const filter = createRfbClientMessageFilter({ startPhase: "clientInit" });
  expect(filter.filter(Buffer.concat([Buffer.from([0]), KEY_EVENT, FRAMEBUFFER_REQUEST]))).toEqual({
    forward: Buffer.concat([Buffer.from([1]), FRAMEBUFFER_REQUEST]),
  });
});

it("drops input messages while forwarding display configuration and update requests", () => {
  const filter = enterMessagePhase();
  const setEncodings = encodings(1);
  const pointerEvent = Buffer.from([5, 1, 0, 10, 0, 20]);
  const extendedPointerEvent = Buffer.from([5, 0x80, 0, 10, 0, 20, 1]);
  const cutText = Buffer.concat([Buffer.from([6, 0, 0, 0, 0, 0, 0, 3]), Buffer.from("abc")]);

  const result = filter.filter(
    Buffer.concat([
      KEY_EVENT,
      PIXEL_FORMAT,
      pointerEvent,
      extendedPointerEvent,
      setEncodings,
      cutText,
      Buffer.concat([Buffer.of(251), Buffer.alloc(23)]),
      Buffer.concat([Buffer.of(255), Buffer.alloc(11)]),
      FRAMEBUFFER_REQUEST,
    ]),
  );

  expect(result).toEqual({
    forward: Buffer.concat([PIXEL_FORMAT, setEncodings, FRAMEBUFFER_REQUEST]),
  });
});

it("forwards the fragmented noVNC 1.7 display and flow-control sequence", () => {
  const filter = enterMessagePhase();
  const setEncodings = encodings(24);
  const clientFence = Buffer.from([248, 0, 0, 0, 0, 0, 0, 0, 1, 0]);
  const enableContinuousUpdates = Buffer.from([150, 1, 0, 0, 0, 0, 0, 64, 0, 64]);
  const cutText = Buffer.alloc(16);
  cutText[0] = 6;
  cutText.writeInt32BE(-8, 4);
  const display = [
    PIXEL_FORMAT,
    setEncodings,
    FRAMEBUFFER_REQUEST,
    clientFence,
    enableContinuousUpdates,
  ];
  const capturedSequence = Buffer.concat([...display, cutText, enableContinuousUpdates]);
  const forwarded: Buffer[] = [];

  for (const byte of capturedSequence) {
    const result = filter.filter(Buffer.of(byte));
    if ("error" in result) {
      throw new Error(result.error);
    }
    forwarded.push(result.forward);
  }

  expect(Buffer.concat(forwarded)).toEqual(Buffer.concat([...display, enableContinuousUpdates]));
});

it.each([
  [false, Buffer.concat([VERSION, Buffer.of(30)]), "unsupported RFB security type 30"],
  [true, Buffer.of(254), "unsupported RFB client message type 254"],
  [
    true,
    Buffer.from([6, 0, 0, 0, 0, 1, 0, 0]),
    "RFB client message exceeds the 64 KiB buffer limit",
  ],
] as const)("fails closed (message phase: %s): %s -> %s", (messagePhase, frame, error) => {
  const filter = messagePhase ? enterMessagePhase() : createRfbClientMessageFilter();
  expect(filter.filter(frame)).toEqual({ error });
});
