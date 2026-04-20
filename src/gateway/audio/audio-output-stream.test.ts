import { describe, expect, it, vi } from "vitest";

import { AudioOutputStream } from "./audio-output-stream.js";
import {
  decodeMultiplexFrame,
  MULTIPLEX_FLAG_EOM,
  MULTIPLEX_STREAM,
} from "../multiplex-frame.js";

describe("AudioOutputStream", () => {
  it("requires a send callback", () => {
    expect(() => new AudioOutputStream({ send: undefined as never })).toThrow(TypeError);
  });

  it("pushAudio enqueues a chunk and emits an encoded multiplex frame", () => {
    const send = vi.fn();
    const stream = new AudioOutputStream({ send });

    const payload = Buffer.from([0x10, 0x20, 0x30, 0x40]);
    const chunk = stream.pushAudio(payload, 50);

    expect(chunk).not.toBeNull();
    expect(chunk!.startMs).toBe(0);
    expect(chunk!.endMs).toBe(50);
    expect(send).toHaveBeenCalledTimes(1);

    const sent = send.mock.calls[0]?.[0] as Buffer;
    const decoded = decodeMultiplexFrame(sent);
    expect(decoded.streamId).toBe(MULTIPLEX_STREAM.AUDIO_OUTPUT);
    expect(decoded.flags).toBe(0);
    expect(decoded.payload.equals(payload)).toBe(true);

    expect(stream.stats.framesSent).toBe(1);
    expect(stream.stats.chunksEnqueued).toBe(1);
    expect(stream.stats.queueLength).toBe(1);
  });

  it("pushAudio with eom=true sets the EOM flag on the frame", () => {
    const send = vi.fn();
    const stream = new AudioOutputStream({ send });

    stream.pushAudio(Buffer.from([0x01, 0x02]), 10, { eom: true });
    const sent = send.mock.calls[0]?.[0] as Buffer;
    const decoded = decodeMultiplexFrame(sent);
    expect(decoded.flags & MULTIPLEX_FLAG_EOM).toBe(MULTIPLEX_FLAG_EOM);
  });

  it("pushAudio passes through extra flags", () => {
    const send = vi.fn();
    const stream = new AudioOutputStream({ send });
    const PRIORITY = 0x02;
    stream.pushAudio(Buffer.from([0x01, 0x02]), 10, { flags: PRIORITY });
    const decoded = decodeMultiplexFrame(send.mock.calls[0]?.[0] as Buffer);
    expect(decoded.flags & PRIORITY).toBe(PRIORITY);
  });

  it("pushAudio rejects non-Buffer payloads", () => {
    const send = vi.fn();
    const stream = new AudioOutputStream({ send });
    expect(() => stream.pushAudio("nope" as never, 10)).toThrow(TypeError);
    expect(send).not.toHaveBeenCalled();
  });

  it("pushAudio with negative duration calls onSendError and does not emit", () => {
    const send = vi.fn();
    const onSendError = vi.fn();
    const stream = new AudioOutputStream({ send, onSendError });

    const result = stream.pushAudio(Buffer.from([0x01, 0x02]), -5);
    expect(result).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(stream.stats.sendErrors).toBe(1);
    expect(onSendError).toHaveBeenCalledTimes(1);
    expect(onSendError.mock.calls[0]?.[0]).toBeInstanceOf(RangeError);
  });

  it("endTurn() emits an EOM-only frame with empty payload", () => {
    const send = vi.fn();
    const stream = new AudioOutputStream({ send });
    stream.endTurn();
    expect(send).toHaveBeenCalledTimes(1);
    const decoded = decodeMultiplexFrame(send.mock.calls[0]?.[0] as Buffer);
    expect(decoded.streamId).toBe(MULTIPLEX_STREAM.AUDIO_OUTPUT);
    expect(decoded.flags & MULTIPLEX_FLAG_EOM).toBe(MULTIPLEX_FLAG_EOM);
    expect(decoded.payload.length).toBe(0);
  });

  it("truncateAt drops trailing chunks and emits an EOM marker", () => {
    const send = vi.fn();
    const onTruncate = vi.fn();
    const stream = new AudioOutputStream({ send, onTruncate });

    stream.pushAudio(Buffer.from([1, 2]), 100);
    stream.pushAudio(Buffer.from([3, 4]), 100);
    stream.pushAudio(Buffer.from([5, 6]), 100);
    expect(send).toHaveBeenCalledTimes(3);

    const result = stream.truncateAt(50);
    expect(result.audioEndMs).toBe(50);
    expect(result.chunksDropped).toBeGreaterThan(0);

    expect(send).toHaveBeenCalledTimes(4);
    const truncFrame = decodeMultiplexFrame(send.mock.calls[3]?.[0] as Buffer);
    expect(truncFrame.flags & MULTIPLEX_FLAG_EOM).toBe(MULTIPLEX_FLAG_EOM);
    expect(truncFrame.payload.length).toBe(0);
    expect(stream.stats.truncations).toBe(1);
    expect(onTruncate).toHaveBeenCalledTimes(1);
  });

  it("STREAM_ID is AUDIO_OUTPUT", () => {
    expect(AudioOutputStream.STREAM_ID).toBe(MULTIPLEX_STREAM.AUDIO_OUTPUT);
  });

  it("reset() clears the buffer", () => {
    const send = vi.fn();
    const stream = new AudioOutputStream({ send });
    stream.pushAudio(Buffer.from([1, 2]), 50);
    expect(stream.stats.queueLength).toBe(1);
    stream.reset();
    expect(stream.stats.queueLength).toBe(0);
    expect(stream.stats.totalEnqueuedMs).toBe(0);
  });

  it("isolates onTruncate consumer errors from the stream", () => {
    const send = vi.fn();
    const onTruncate = () => {
      throw new Error("downstream boom");
    };
    const stream = new AudioOutputStream({ send, onTruncate });
    stream.pushAudio(Buffer.from([1, 2]), 100);
    expect(() => stream.truncateAt(50)).not.toThrow();
  });

  it("captures send errors via onSendError when send() throws", () => {
    const onSendError = vi.fn();
    const stream = new AudioOutputStream({
      send: () => {
        throw new Error("socket closed");
      },
      onSendError,
    });
    stream.pushAudio(Buffer.from([1, 2]), 10);
    expect(onSendError).toHaveBeenCalledTimes(1);
    expect(stream.stats.sendErrors).toBe(1);
    // Chunk WAS enqueued before the send error.
    expect(stream.stats.chunksEnqueued).toBe(1);
  });

  it("tracks bytesSent across multiple frames", () => {
    const send = vi.fn();
    const stream = new AudioOutputStream({ send });
    stream.pushAudio(Buffer.from([1, 2]), 10);
    stream.pushAudio(Buffer.from([3, 4, 5, 6]), 10);
    const total = (send.mock.calls[0]?.[0] as Buffer).length + (send.mock.calls[1]?.[0] as Buffer).length;
    expect(stream.stats.bytesSent).toBe(total);
  });
});
