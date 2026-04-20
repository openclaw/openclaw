import { describe, expect, it, vi } from "vitest";
import {
  MultiplexDemuxer,
  MultiplexDemuxError,
  looksLikeMultiplexedTraffic,
} from "./multiplex-demux.js";
import {
  encodeMultiplexFrame,
  MULTIPLEX_FLAG_EOM,
  MULTIPLEX_STREAM,
  type MultiplexFrame,
} from "./multiplex-frame.js";

function frame(streamId: number, payload: Buffer | string, flags = 0): Buffer {
  return encodeMultiplexFrame(
    streamId,
    typeof payload === "string" ? Buffer.from(payload) : payload,
    flags,
  );
}

describe("MultiplexDemuxer", () => {
  it("dispatches a single frame to the registered handler", () => {
    const handler = vi.fn();
    const demux = new MultiplexDemuxer({
      handlers: { [MULTIPLEX_STREAM.AUDIO_INPUT]: handler },
    });

    const dispatched = demux.push(frame(MULTIPLEX_STREAM.AUDIO_INPUT, "hello"));

    expect(dispatched).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
    const call = handler.mock.calls[0]?.[0] as MultiplexFrame;
    expect(call.streamId).toBe(MULTIPLEX_STREAM.AUDIO_INPUT);
    expect(call.payload.toString()).toBe("hello");
  });

  it("dispatches multiple concatenated frames in order", () => {
    const audioIn = vi.fn();
    const audioOut = vi.fn();
    const demux = new MultiplexDemuxer({
      handlers: {
        [MULTIPLEX_STREAM.AUDIO_INPUT]: audioIn,
        [MULTIPLEX_STREAM.AUDIO_OUTPUT]: audioOut,
      },
    });

    const combined = Buffer.concat([
      frame(MULTIPLEX_STREAM.AUDIO_INPUT, "a"),
      frame(MULTIPLEX_STREAM.AUDIO_OUTPUT, "b"),
      frame(MULTIPLEX_STREAM.AUDIO_INPUT, "c"),
    ]);

    const dispatched = demux.push(combined);

    expect(dispatched).toBe(3);
    expect(audioIn).toHaveBeenCalledTimes(2);
    expect(audioOut).toHaveBeenCalledTimes(1);
    expect((audioIn.mock.calls[0]?.[0] as MultiplexFrame).payload.toString()).toBe("a");
    expect((audioOut.mock.calls[0]?.[0] as MultiplexFrame).payload.toString()).toBe("b");
    expect((audioIn.mock.calls[1]?.[0] as MultiplexFrame).payload.toString()).toBe("c");
  });

  it("buffers a partial frame and dispatches once completed across pushes", () => {
    const handler = vi.fn();
    const demux = new MultiplexDemuxer({
      handlers: { [MULTIPLEX_STREAM.AUDIO_INPUT]: handler },
    });

    const full = frame(MULTIPLEX_STREAM.AUDIO_INPUT, "split-payload");
    const split = Math.floor(full.length / 2);
    const a = full.subarray(0, split);
    const b = full.subarray(split);

    expect(demux.push(a)).toBe(0);
    expect(handler).not.toHaveBeenCalled();
    expect(demux.stats.bufferedBytes).toBe(a.length);

    expect(demux.push(b)).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect((handler.mock.calls[0]?.[0] as MultiplexFrame).payload.toString()).toBe("split-payload");
    expect(demux.stats.bufferedBytes).toBe(0);
  });

  it("preserves trailing partial frame after a complete one", () => {
    const handler = vi.fn();
    const demux = new MultiplexDemuxer({
      handlers: { [MULTIPLEX_STREAM.AUDIO_INPUT]: handler },
    });

    const full = frame(MULTIPLEX_STREAM.AUDIO_INPUT, "complete");
    const next = frame(MULTIPLEX_STREAM.AUDIO_INPUT, "second");
    const partial = next.subarray(0, 4);

    const dispatched = demux.push(Buffer.concat([full, partial]));
    expect(dispatched).toBe(1);
    expect(demux.stats.bufferedBytes).toBe(4);

    const rest = next.subarray(4);
    expect(demux.push(rest)).toBe(1);
    expect(handler).toHaveBeenCalledTimes(2);
    expect((handler.mock.calls[1]?.[0] as MultiplexFrame).payload.toString()).toBe("second");
  });

  it("invokes onUnknownStream when no handler is registered for a streamId", () => {
    const unknown = vi.fn();
    const demux = new MultiplexDemuxer({ onUnknownStream: unknown });

    demux.push(frame(99, "mystery"));

    expect(unknown).toHaveBeenCalledTimes(1);
    expect((unknown.mock.calls[0]?.[0] as MultiplexFrame).streamId).toBe(99);
  });

  it("silently drops frames for unknown streams when no fallback is set", () => {
    const demux = new MultiplexDemuxer();
    expect(() => demux.push(frame(7, "x"))).not.toThrow();
    expect(demux.stats.framesDispatched).toBe(1);
  });

  it("registers and removes handlers via on() / off()", () => {
    const demux = new MultiplexDemuxer();
    const handler = vi.fn();
    demux.on(3, handler);
    demux.push(frame(3, "first"));
    demux.off(3);
    demux.push(frame(3, "second"));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid streamId in on()", () => {
    const demux = new MultiplexDemuxer();
    expect(() => demux.on(-1, vi.fn())).toThrow(RangeError);
    expect(() => demux.on(256, vi.fn())).toThrow(RangeError);
    expect(() => demux.on(1.5, vi.fn())).toThrow(RangeError);
  });

  it("propagates flags to handlers (EOM bit)", () => {
    const handler = vi.fn();
    const demux = new MultiplexDemuxer({
      handlers: { [MULTIPLEX_STREAM.AUDIO_INPUT]: handler },
    });
    demux.push(frame(MULTIPLEX_STREAM.AUDIO_INPUT, "end", MULTIPLEX_FLAG_EOM));
    const f = handler.mock.calls[0]?.[0] as MultiplexFrame;
    expect(f.flags & MULTIPLEX_FLAG_EOM).toBe(MULTIPLEX_FLAG_EOM);
  });

  it("calls onError and resets buffer on a decode error", () => {
    const onError = vi.fn();
    const demux = new MultiplexDemuxer({ onError });

    // Bytes that don't start with the magic byte → MISSING_MAGIC after carry.
    demux.push(Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(demux.stats.bufferedBytes).toBe(0);
    expect(demux.stats.decodeErrors).toBe(1);

    // Demuxer should remain usable for a fresh valid frame.
    const handler = vi.fn();
    demux.on(MULTIPLEX_STREAM.AUDIO_INPUT, handler);
    demux.push(frame(MULTIPLEX_STREAM.AUDIO_INPUT, "after-error"));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("calls onError when a handler throws but continues dispatching subsequent frames", () => {
    const onError = vi.fn();
    const second = vi.fn();
    const demux = new MultiplexDemuxer({ onError });
    demux.on(MULTIPLEX_STREAM.AUDIO_INPUT, () => {
      throw new Error("boom");
    });
    demux.on(MULTIPLEX_STREAM.AUDIO_OUTPUT, second);

    demux.push(
      Buffer.concat([
        frame(MULTIPLEX_STREAM.AUDIO_INPUT, "first"),
        frame(MULTIPLEX_STREAM.AUDIO_OUTPUT, "second"),
      ]),
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("enforces maxBufferBytes and surfaces a BUFFER_OVERFLOW error", () => {
    const onError = vi.fn();
    const demux = new MultiplexDemuxer({ onError, maxBufferBytes: 16 });
    // Send more than 16 bytes that don't form a complete frame yet.
    const partial = frame(MULTIPLEX_STREAM.AUDIO_INPUT, Buffer.alloc(64, 0x41)).subarray(0, 12);
    demux.push(partial);
    demux.push(partial);
    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0]?.[0] as MultiplexDemuxError;
    expect(err).toBeInstanceOf(MultiplexDemuxError);
    expect(err.code).toBe("BUFFER_OVERFLOW");
    expect(demux.stats.bufferedBytes).toBe(0);
  });

  it("reset() drops the carry buffer", () => {
    const demux = new MultiplexDemuxer();
    const partial = frame(MULTIPLEX_STREAM.AUDIO_INPUT, "x").subarray(0, 4);
    demux.push(partial);
    expect(demux.stats.bufferedBytes).toBeGreaterThan(0);
    demux.reset();
    expect(demux.stats.bufferedBytes).toBe(0);
  });

  it("tracks bytesProcessed and framesDispatched in stats", () => {
    const demux = new MultiplexDemuxer({ handlers: { 1: vi.fn() } });
    const buf = Buffer.concat([frame(1, "a"), frame(1, "bb"), frame(1, "ccc")]);
    demux.push(buf);
    expect(demux.stats.framesDispatched).toBe(3);
    expect(demux.stats.bytesProcessed).toBe(buf.length);
  });

  it("decoded payloads are detached copies safe for retention", () => {
    let captured: MultiplexFrame | undefined;
    const demux = new MultiplexDemuxer({
      handlers: { 1: (f) => (captured = f) },
    });
    const payload = Buffer.from("retain-me");
    const enc = frame(1, payload);
    demux.push(enc);
    // Mutate the source buffer; payload received by handler must be unaffected.
    enc.fill(0);
    expect(captured?.payload.toString()).toBe("retain-me");
  });
});

describe("looksLikeMultiplexedTraffic", () => {
  it("returns true for an encoded multiplex frame", () => {
    expect(looksLikeMultiplexedTraffic(frame(1, "x"))).toBe(true);
  });

  it("returns false for plain JSON-like text bytes", () => {
    expect(looksLikeMultiplexedTraffic(Buffer.from('{"hello":1}'))).toBe(false);
  });

  it("returns false for non-Buffer inputs", () => {
    expect(looksLikeMultiplexedTraffic(undefined)).toBe(false);
    expect(looksLikeMultiplexedTraffic("string")).toBe(false);
    expect(looksLikeMultiplexedTraffic(42)).toBe(false);
  });

  it("returns false for an under-sized buffer (just the magic byte)", () => {
    expect(looksLikeMultiplexedTraffic(Buffer.from([0xfe]))).toBe(false);
  });
});
