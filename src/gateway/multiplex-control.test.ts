import { describe, expect, it, vi } from "vitest";

import {
  computeBackpressureLevel,
  MultiplexControlChannel,
  type BackpressureMessage,
  type ControlAckMessage,
  type ControlErrorMessage,
  type PauseResumeMessage,
} from "./multiplex-control.js";
import {
  decodeMultiplexFrame,
  encodeMultiplexFrame,
  MULTIPLEX_FLAG_PRIORITY,
  MULTIPLEX_STREAM,
  type MultiplexFrame,
} from "./multiplex-frame.js";

function controlFrame(payload: object): MultiplexFrame {
  const buf = encodeMultiplexFrame(
    MULTIPLEX_STREAM.CONTROL,
    Buffer.from(JSON.stringify(payload)),
  );
  return decodeMultiplexFrame(buf);
}

function decodeSent(send: ReturnType<typeof vi.fn>, idx = 0): { frame: MultiplexFrame; payload: Record<string, unknown> } {
  const buf = send.mock.calls[idx]?.[0] as Buffer;
  const frame = decodeMultiplexFrame(buf);
  const payload = JSON.parse(frame.payload.toString("utf8")) as Record<string, unknown>;
  return { frame, payload };
}

describe("MultiplexControlChannel — outbound", () => {
  it("requires a send callback", () => {
    expect(() => new MultiplexControlChannel({ send: undefined as never })).toThrow(TypeError);
  });

  it("sendBackpressure emits a frame on streamId CONTROL with PRIORITY flag", () => {
    const send = vi.fn();
    const ch = new MultiplexControlChannel({ send });

    const sent = ch.sendBackpressure("high", { bufferedBytes: 1024, queuedFrames: 5 });
    expect(sent).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const { frame, payload } = decodeSent(send);
    expect(frame.streamId).toBe(MULTIPLEX_STREAM.CONTROL);
    expect(frame.flags & MULTIPLEX_FLAG_PRIORITY).toBe(MULTIPLEX_FLAG_PRIORITY);
    expect(payload).toMatchObject({
      type: "backpressure",
      level: "high",
      bufferedBytes: 1024,
      queuedFrames: 5,
    });
  });

  it("sendBackpressure is idempotent on level (no duplicate frames)", () => {
    const send = vi.fn();
    const ch = new MultiplexControlChannel({ send });
    expect(ch.sendBackpressure("high")).toBe(true);
    expect(ch.sendBackpressure("high")).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sendBackpressure(force=true) bypasses idempotence", () => {
    const send = vi.fn();
    const ch = new MultiplexControlChannel({ send });
    ch.sendBackpressure("high");
    ch.sendBackpressure("high", { force: true });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("sendPause / sendResume emit pause/resume frames", () => {
    const send = vi.fn();
    const ch = new MultiplexControlChannel({ send });
    ch.sendPause(MULTIPLEX_STREAM.AUDIO_INPUT);
    ch.sendResume(MULTIPLEX_STREAM.AUDIO_INPUT);
    expect(send).toHaveBeenCalledTimes(2);

    const a = decodeSent(send, 0);
    const b = decodeSent(send, 1);
    expect(a.payload).toMatchObject({ type: "pause", streamId: MULTIPLEX_STREAM.AUDIO_INPUT });
    expect(b.payload).toMatchObject({ type: "resume", streamId: MULTIPLEX_STREAM.AUDIO_INPUT });
  });

  it("sendPause without a streamId encodes connection-wide pause", () => {
    const send = vi.fn();
    const ch = new MultiplexControlChannel({ send });
    ch.sendPause();
    const { payload } = decodeSent(send);
    expect(payload.type).toBe("pause");
    expect(payload.streamId).toBeUndefined();
  });

  it("sendError encodes a stream-level error", () => {
    const send = vi.fn();
    const ch = new MultiplexControlChannel({ send });
    ch.sendError("RATE_LIMIT", "too many frames", MULTIPLEX_STREAM.AUDIO_INPUT);
    const { payload } = decodeSent(send);
    expect(payload).toMatchObject({
      type: "error",
      code: "RATE_LIMIT",
      message: "too many frames",
      streamId: MULTIPLEX_STREAM.AUDIO_INPUT,
    });
  });

  it("sendAck includes forType and arbitrary extras", () => {
    const send = vi.fn();
    const ch = new MultiplexControlChannel({ send });
    ch.sendAck("backpressure", { bufferedBytes: 0 });
    const { payload } = decodeSent(send);
    expect(payload).toMatchObject({ type: "ack", forType: "backpressure", bufferedBytes: 0 });
  });

  it("tracks framesSent in stats", () => {
    const send = vi.fn();
    const ch = new MultiplexControlChannel({ send });
    ch.sendBackpressure("high");
    ch.sendPause();
    ch.sendResume();
    ch.sendError("X", "y");
    expect(ch.stats.framesSent).toBe(4);
  });
});

describe("MultiplexControlChannel — inbound", () => {
  it("dispatches a backpressure message to onBackpressure", () => {
    const send = vi.fn();
    const onBackpressure = vi.fn<(msg: BackpressureMessage) => void>();
    const ch = new MultiplexControlChannel({ send, onBackpressure });
    ch.handleFrame(controlFrame({ type: "backpressure", level: "high", bufferedBytes: 2048 }));
    expect(onBackpressure).toHaveBeenCalledTimes(1);
    expect(onBackpressure.mock.calls[0]?.[0]).toMatchObject({ level: "high", bufferedBytes: 2048 });
    expect(ch.stats.lastReceivedBackpressureLevel).toBe("high");
  });

  it("dispatches pause/resume messages", () => {
    const send = vi.fn();
    const onPause = vi.fn<(msg: PauseResumeMessage) => void>();
    const onResume = vi.fn<(msg: PauseResumeMessage) => void>();
    const ch = new MultiplexControlChannel({ send, onPause, onResume });
    ch.handleFrame(controlFrame({ type: "pause", streamId: 1 }));
    ch.handleFrame(controlFrame({ type: "resume" }));
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onPause.mock.calls[0]?.[0]?.streamId).toBe(1);
  });

  it("dispatches an error message", () => {
    const send = vi.fn();
    const onError = vi.fn<(msg: ControlErrorMessage) => void>();
    const ch = new MultiplexControlChannel({ send, onError });
    ch.handleFrame(controlFrame({ type: "error", code: "BOOM", message: "x", streamId: 2 }));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: "BOOM", message: "x", streamId: 2 });
  });

  it("dispatches an ack message", () => {
    const send = vi.fn();
    const onAck = vi.fn<(msg: ControlAckMessage) => void>();
    const ch = new MultiplexControlChannel({ send, onAck });
    ch.handleFrame(controlFrame({ type: "ack", forType: "backpressure", extra: 1 }));
    expect(onAck).toHaveBeenCalledTimes(1);
    expect(onAck.mock.calls[0]?.[0]?.forType).toBe("backpressure");
  });

  it("calls onUnknown for unknown types", () => {
    const send = vi.fn();
    const onUnknown = vi.fn();
    const ch = new MultiplexControlChannel({ send, onUnknown });
    ch.handleFrame(controlFrame({ type: "future-thing", payload: { x: 1 } }));
    expect(onUnknown).toHaveBeenCalledTimes(1);
    expect((onUnknown.mock.calls[0]?.[0] as Record<string, unknown>)?.type).toBe("future-thing");
  });

  it("calls onParseError on invalid JSON", () => {
    const send = vi.fn();
    const onParseError = vi.fn();
    const ch = new MultiplexControlChannel({ send, onParseError });
    const garbage = encodeMultiplexFrame(MULTIPLEX_STREAM.CONTROL, Buffer.from("not json{{"));
    ch.handleFrame(decodeMultiplexFrame(garbage));
    expect(onParseError).toHaveBeenCalledTimes(1);
    expect(ch.stats.parseErrors).toBe(1);
  });

  it("calls onParseError when payload is not a JSON object", () => {
    const send = vi.fn();
    const onParseError = vi.fn();
    const ch = new MultiplexControlChannel({ send, onParseError });
    ch.handleFrame(controlFrame([1, 2, 3] as never));
    expect(onParseError).toHaveBeenCalledTimes(1);
  });

  it("calls onParseError when backpressure missing level", () => {
    const send = vi.fn();
    const onParseError = vi.fn();
    const onBackpressure = vi.fn();
    const ch = new MultiplexControlChannel({ send, onBackpressure, onParseError });
    ch.handleFrame(controlFrame({ type: "backpressure" }));
    expect(onParseError).toHaveBeenCalledTimes(1);
    expect(onBackpressure).not.toHaveBeenCalled();
  });

  it("ignores frames for non-CONTROL streamIds", () => {
    const send = vi.fn();
    const onBackpressure = vi.fn();
    const ch = new MultiplexControlChannel({ send, onBackpressure });
    const wrongStream: MultiplexFrame = {
      streamId: MULTIPLEX_STREAM.AUDIO_INPUT,
      flags: 0,
      payload: Buffer.from(JSON.stringify({ type: "backpressure", level: "high" })),
    };
    ch.handleFrame(wrongStream);
    expect(onBackpressure).not.toHaveBeenCalled();
  });

  it("tracks framesReceived", () => {
    const send = vi.fn();
    const ch = new MultiplexControlChannel({ send });
    ch.handleFrame(controlFrame({ type: "ack", forType: "x" }));
    ch.handleFrame(controlFrame({ type: "ack", forType: "y" }));
    expect(ch.stats.framesReceived).toBe(2);
  });
});

describe("computeBackpressureLevel", () => {
  it("returns 'high' when current crosses high watermark from idle", () => {
    expect(computeBackpressureLevel(2_000_000, 1_000_000, 250_000, null)).toBe("high");
  });

  it("returns null when already in 'high' state and still above high watermark", () => {
    expect(computeBackpressureLevel(2_000_000, 1_000_000, 250_000, "high")).toBeNull();
  });

  it("returns 'low' when draining below low watermark from 'high'", () => {
    expect(computeBackpressureLevel(100_000, 1_000_000, 250_000, "high")).toBe("low");
  });

  it("returns null when between watermarks (hysteresis)", () => {
    expect(computeBackpressureLevel(500_000, 1_000_000, 250_000, "high")).toBeNull();
    expect(computeBackpressureLevel(500_000, 1_000_000, 250_000, null)).toBeNull();
  });

  it("returns null when already 'low' and still below low watermark", () => {
    expect(computeBackpressureLevel(100_000, 1_000_000, 250_000, "low")).toBeNull();
  });
});
