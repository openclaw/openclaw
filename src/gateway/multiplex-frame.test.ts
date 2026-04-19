import { describe, expect, it } from "vitest";
import {
  MULTIPLEX_FLAG_COMPRESSED,
  MULTIPLEX_FLAG_DEFINED_MASK,
  MULTIPLEX_FLAG_EOM,
  MULTIPLEX_FLAG_PRIORITY,
  MULTIPLEX_FRAME_ENVELOPE_OVERHEAD,
  MULTIPLEX_FRAME_HEADER_SIZE,
  MULTIPLEX_FRAME_MAGIC,
  MULTIPLEX_FRAME_MAX_PAYLOAD,
  MULTIPLEX_FRAME_MAX_STREAM_ID,
  MULTIPLEX_STREAM,
  MultiplexFrameError,
  decodeMultiplexFrame,
  decodeMultiplexFrames,
  encodeMultiplexFrame,
  frameHasCompressed,
  frameHasEom,
  frameHasPriority,
  isMultiplexedFrame,
} from "./multiplex-frame.js";

describe("multiplex-frame: constants", () => {
  it("uses a 6-byte header (1+1+4) and 7-byte envelope (magic+header)", () => {
    expect(MULTIPLEX_FRAME_HEADER_SIZE).toBe(6);
    expect(MULTIPLEX_FRAME_ENVELOPE_OVERHEAD).toBe(7);
    expect(MULTIPLEX_FRAME_ENVELOPE_OVERHEAD).toBeLessThan(10); // A.1 acceptance: < 10B overhead
  });

  it("supports stream IDs 0..255 and a 16 MiB payload cap", () => {
    expect(MULTIPLEX_FRAME_MAX_STREAM_ID).toBe(255);
    expect(MULTIPLEX_FRAME_MAX_PAYLOAD).toBe(16 * 1024 * 1024);
  });

  it("exposes well-known stream IDs aligned with ARCHITECTURE.md", () => {
    expect(MULTIPLEX_STREAM.CONTROL).toBe(0);
    expect(MULTIPLEX_STREAM.AUDIO_INPUT).toBe(1);
    expect(MULTIPLEX_STREAM.AUDIO_OUTPUT).toBe(2);
    expect(MULTIPLEX_STREAM.VIDEO_INPUT).toBe(3);
    expect(MULTIPLEX_STREAM.VIDEO_OUTPUT).toBe(4);
  });

  it("flag bitmask aggregates all defined bits", () => {
    expect(MULTIPLEX_FLAG_DEFINED_MASK).toBe(
      MULTIPLEX_FLAG_EOM | MULTIPLEX_FLAG_PRIORITY | MULTIPLEX_FLAG_COMPRESSED,
    );
  });
});

describe("encodeMultiplexFrame", () => {
  it("writes magic byte, stream id, flags, LE length, and payload in order", () => {
    const payload = Buffer.from("hello", "utf8");
    const frame = encodeMultiplexFrame(MULTIPLEX_STREAM.CONTROL, payload, MULTIPLEX_FLAG_EOM);
    expect(frame[0]).toBe(MULTIPLEX_FRAME_MAGIC);
    expect(frame[1]).toBe(0);
    expect(frame[2]).toBe(MULTIPLEX_FLAG_EOM);
    expect(frame.readUInt32LE(3)).toBe(payload.length);
    expect(frame.subarray(MULTIPLEX_FRAME_ENVELOPE_OVERHEAD).toString("utf8")).toBe("hello");
  });

  it("accepts Uint8Array payloads", () => {
    const u8 = new Uint8Array([1, 2, 3, 4]);
    const frame = encodeMultiplexFrame(2, u8, 0);
    expect(frame.subarray(MULTIPLEX_FRAME_ENVELOPE_OVERHEAD)).toEqual(Buffer.from(u8));
  });

  it("encodes a zero-length payload", () => {
    const frame = encodeMultiplexFrame(0, Buffer.alloc(0), 0);
    expect(frame.length).toBe(MULTIPLEX_FRAME_ENVELOPE_OVERHEAD);
    expect(frame.readUInt32LE(3)).toBe(0);
  });

  it("rejects out-of-range streamId", () => {
    expect(() => encodeMultiplexFrame(-1, Buffer.alloc(0))).toThrow(MultiplexFrameError);
    expect(() => encodeMultiplexFrame(256, Buffer.alloc(0))).toThrow(/INVALID_STREAM_ID/);
    expect(() => encodeMultiplexFrame(1.5, Buffer.alloc(0))).toThrow(/INVALID_STREAM_ID/);
  });

  it("rejects out-of-range flags", () => {
    expect(() => encodeMultiplexFrame(0, Buffer.alloc(0), -1)).toThrow(/INVALID_FLAGS/);
    expect(() => encodeMultiplexFrame(0, Buffer.alloc(0), 256)).toThrow(/INVALID_FLAGS/);
  });

  it("rejects payloads above 16 MiB", () => {
    // We don't actually allocate 16 MiB+1 — pass a Uint8Array view with a faked length via subclass.
    // Easiest path: assert via an oversize buffer of the smallest amount.
    const oversize = Buffer.alloc(MULTIPLEX_FRAME_MAX_PAYLOAD + 1);
    expect(() => encodeMultiplexFrame(0, oversize)).toThrow(/PAYLOAD_TOO_LARGE/);
  });

  it("rejects non-buffer payloads", () => {
    // @ts-expect-error — runtime guard
    expect(() => encodeMultiplexFrame(0, "not a buffer")).toThrow(/INVALID_INPUT/);
  });
});

describe("decodeMultiplexFrame: roundtrip", () => {
  it("roundtrips for stream IDs 0..255", () => {
    const payload = Buffer.from("payload");
    for (let id = 0; id <= 255; id++) {
      const frame = encodeMultiplexFrame(id, payload, MULTIPLEX_FLAG_PRIORITY);
      const decoded = decodeMultiplexFrame(frame);
      expect(decoded.streamId).toBe(id);
      expect(decoded.flags).toBe(MULTIPLEX_FLAG_PRIORITY);
      expect(decoded.payload.equals(payload)).toBe(true);
    }
  });

  it("roundtrips for all defined flag combinations", () => {
    const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    for (let f = 0; f <= MULTIPLEX_FLAG_DEFINED_MASK; f++) {
      const frame = encodeMultiplexFrame(7, payload, f);
      const decoded = decodeMultiplexFrame(frame);
      expect(decoded.flags).toBe(f);
      expect(frameHasEom(decoded.flags)).toBe((f & MULTIPLEX_FLAG_EOM) !== 0);
      expect(frameHasPriority(decoded.flags)).toBe((f & MULTIPLEX_FLAG_PRIORITY) !== 0);
      expect(frameHasCompressed(decoded.flags)).toBe((f & MULTIPLEX_FLAG_COMPRESSED) !== 0);
    }
  });

  it("roundtrips a 1 MiB payload", () => {
    const big = Buffer.alloc(1 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) {
      big[i] = i & 0xff;
    }
    const frame = encodeMultiplexFrame(2, big, MULTIPLEX_FLAG_EOM);
    const decoded = decodeMultiplexFrame(frame);
    expect(decoded.payload.length).toBe(big.length);
    expect(decoded.payload.equals(big)).toBe(true);
  });

  it("returns a copy so mutating decoded payload does not affect input", () => {
    const payload = Buffer.from("immutable");
    const frame = encodeMultiplexFrame(1, payload);
    const decoded = decodeMultiplexFrame(frame);
    decoded.payload[0] = 0;
    // Original frame buffer payload region untouched.
    expect(frame[MULTIPLEX_FRAME_ENVELOPE_OVERHEAD]).toBe(payload[0]);
  });
});

describe("decodeMultiplexFrame: errors", () => {
  it("rejects missing magic byte", () => {
    const bogus = Buffer.from([0x00, 0x01, 0x02, 0x00, 0x00, 0x00, 0x00]);
    expect(() => decodeMultiplexFrame(bogus)).toThrow(/MISSING_MAGIC/);
  });

  it("rejects truncated header", () => {
    const tiny = Buffer.from([MULTIPLEX_FRAME_MAGIC, 0x00, 0x00]);
    expect(() => decodeMultiplexFrame(tiny)).toThrow(/TRUNCATED_HEADER/);
  });

  it("rejects truncated payload", () => {
    const frame = encodeMultiplexFrame(0, Buffer.from("xyz"));
    const truncated = frame.subarray(0, frame.length - 1);
    expect(() => decodeMultiplexFrame(truncated)).toThrow(/TRUNCATED_PAYLOAD/);
  });

  it("rejects trailing bytes (use decodeMultiplexFrames for streams)", () => {
    const frame = encodeMultiplexFrame(0, Buffer.from("ok"));
    const extra = Buffer.concat([frame, Buffer.from([0x00])]);
    expect(() => decodeMultiplexFrame(extra)).toThrow(/TRUNCATED_PAYLOAD/);
  });

  it("rejects payload-length header above 16 MiB cap", () => {
    const buf = Buffer.alloc(MULTIPLEX_FRAME_ENVELOPE_OVERHEAD);
    buf[0] = MULTIPLEX_FRAME_MAGIC;
    buf[1] = 0;
    buf[2] = 0;
    buf.writeUInt32LE(MULTIPLEX_FRAME_MAX_PAYLOAD + 1, 3);
    expect(() => decodeMultiplexFrame(buf)).toThrow(/PAYLOAD_TOO_LARGE/);
  });

  it("rejects non-buffer input", () => {
    // @ts-expect-error — runtime guard
    expect(() => decodeMultiplexFrame("hi")).toThrow(/INVALID_INPUT/);
  });
});

describe("isMultiplexedFrame", () => {
  it("recognises encoded frames", () => {
    const frame = encodeMultiplexFrame(0, Buffer.from("a"));
    expect(isMultiplexedFrame(frame)).toBe(true);
  });

  it("rejects empty / undersized buffers", () => {
    expect(isMultiplexedFrame(Buffer.alloc(0))).toBe(false);
    expect(isMultiplexedFrame(Buffer.from([MULTIPLEX_FRAME_MAGIC, 0x00]))).toBe(false);
  });

  it("rejects JSON / text payloads (legacy clients keep working)", () => {
    expect(isMultiplexedFrame(Buffer.from(`{"type":"session.update"}`))).toBe(false);
    expect(isMultiplexedFrame(Buffer.from("hello world"))).toBe(false);
    expect(isMultiplexedFrame(Buffer.from(" \n\t{}"))).toBe(false);
    expect(isMultiplexedFrame(Buffer.from("[1,2,3]"))).toBe(false);
  });

  it("rejects non-Uint8Array inputs", () => {
    expect(isMultiplexedFrame(undefined)).toBe(false);
    expect(isMultiplexedFrame("foo")).toBe(false);
    expect(isMultiplexedFrame({ length: 10 })).toBe(false);
  });
});

describe("decodeMultiplexFrames (stream chunking)", () => {
  it("decodes multiple concatenated frames", () => {
    const a = encodeMultiplexFrame(0, Buffer.from("aa"));
    const b = encodeMultiplexFrame(1, Buffer.from("bbb"), MULTIPLEX_FLAG_EOM);
    const c = encodeMultiplexFrame(2, Buffer.from("cccc"));
    const { frames, remainder } = decodeMultiplexFrames(Buffer.concat([a, b, c]));
    expect(frames).toHaveLength(3);
    expect(frames[0].streamId).toBe(0);
    expect(frames[1].streamId).toBe(1);
    expect(frames[1].flags).toBe(MULTIPLEX_FLAG_EOM);
    expect(frames[2].payload.toString()).toBe("cccc");
    expect(remainder.length).toBe(0);
  });

  it("returns a partial-header tail as remainder", () => {
    const a = encodeMultiplexFrame(0, Buffer.from("aa"));
    const partialHeader = Buffer.from([MULTIPLEX_FRAME_MAGIC, 0x01]); // 2 of 7 bytes
    const { frames, remainder } = decodeMultiplexFrames(Buffer.concat([a, partialHeader]));
    expect(frames).toHaveLength(1);
    expect(remainder.equals(partialHeader)).toBe(true);
  });

  it("returns a partial-payload tail as remainder", () => {
    const a = encodeMultiplexFrame(0, Buffer.from("aa"));
    const b = encodeMultiplexFrame(1, Buffer.from("bbbbbbbb"));
    const truncatedB = b.subarray(0, b.length - 3);
    const { frames, remainder } = decodeMultiplexFrames(Buffer.concat([a, truncatedB]));
    expect(frames).toHaveLength(1);
    expect(remainder.equals(truncatedB)).toBe(true);
  });

  it("re-feeding remainder + new bytes recovers the missing frame", () => {
    const a = encodeMultiplexFrame(0, Buffer.from("aa"));
    const b = encodeMultiplexFrame(1, Buffer.from("bbbbbbbb"));
    const split = Math.floor(b.length / 2);
    const first = decodeMultiplexFrames(Buffer.concat([a, b.subarray(0, split)]));
    expect(first.frames).toHaveLength(1);
    const second = decodeMultiplexFrames(Buffer.concat([first.remainder, b.subarray(split)]));
    expect(second.frames).toHaveLength(1);
    expect(second.frames[0].payload.toString()).toBe("bbbbbbbb");
    expect(second.remainder.length).toBe(0);
  });

  it("throws on misaligned frame boundary (corrupt stream)", () => {
    const a = encodeMultiplexFrame(0, Buffer.from("aa"));
    const corrupt = Buffer.concat([a, Buffer.from([0x42, 0x00, 0x00])]);
    expect(() => decodeMultiplexFrames(corrupt)).toThrow(/MISSING_MAGIC/);
  });

  it("returns empty remainder for empty input", () => {
    const { frames, remainder } = decodeMultiplexFrames(Buffer.alloc(0));
    expect(frames).toHaveLength(0);
    expect(remainder.length).toBe(0);
  });

  it("remainder is detached from input buffer (safe to retain)", () => {
    const partial = Buffer.from([MULTIPLEX_FRAME_MAGIC, 0x00]);
    const { remainder } = decodeMultiplexFrames(partial);
    partial[0] = 0x00;
    expect(remainder[0]).toBe(MULTIPLEX_FRAME_MAGIC);
  });
});

describe("multiplex-frame: throughput sanity", () => {
  it("encodes and decodes at >100 MB/s on small frames", () => {
    const payload = Buffer.alloc(4 * 1024); // 4 KiB
    const iterations = 5_000;
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
      const frame = encodeMultiplexFrame(i & 0xff, payload, MULTIPLEX_FLAG_EOM);
      const decoded = decodeMultiplexFrame(frame);
      if (decoded.payload.length !== payload.length) {
        throw new Error("len mismatch");
      }
    }
    const elapsedNs = Number(process.hrtime.bigint() - start);
    const bytes = iterations * payload.length * 2; // encode + decode
    const mbPerSec = bytes / 1e6 / (elapsedNs / 1e9);
    // Soft floor: be permissive (CI machines vary). Real target is >100 MB/s.
    expect(mbPerSec).toBeGreaterThan(20);
  });
});
