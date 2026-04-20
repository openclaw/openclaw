import { describe, expect, it, vi } from "vitest";

import { AudioInputStream } from "./audio-input-stream.js";
import {
  encodeMultiplexFrame,
  decodeMultiplexFrame,
  MULTIPLEX_FLAG_EOM,
  MULTIPLEX_STREAM,
  type MultiplexFrame,
} from "../multiplex-frame.js";

function pcmFrame(payload: Buffer, flags = 0, streamId = MULTIPLEX_STREAM.AUDIO_INPUT): MultiplexFrame {
  return decodeMultiplexFrame(encodeMultiplexFrame(streamId, payload, flags));
}

function pcm16Bytes(samples: number[]): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => buf.writeInt16LE(v, i * 2));
  return buf;
}

describe("AudioInputStream", () => {
  it("appends frame payloads to the buffer", () => {
    const audioIn = new AudioInputStream();
    const chunk = pcm16Bytes([100, 200, 300, 400]);
    audioIn.handleFrame(pcmFrame(chunk));

    expect(audioIn.stats.framesAccepted).toBe(1);
    expect(audioIn.stats.bytesAccepted).toBe(chunk.length);
    expect(audioIn.stats.bufferedBytes).toBe(chunk.length);
    expect(audioIn.stats.commitsEmitted).toBe(0);
  });

  it("commits on EOM-flagged frame and fires onCommit", () => {
    const onCommit = vi.fn();
    const audioIn = new AudioInputStream({ onCommit });

    audioIn.handleFrame(pcmFrame(pcm16Bytes([1, 2, 3, 4])));
    audioIn.handleFrame(pcmFrame(pcm16Bytes([5, 6, 7, 8]), MULTIPLEX_FLAG_EOM));

    expect(audioIn.stats.commitsEmitted).toBe(1);
    expect(onCommit).toHaveBeenCalledTimes(1);
    const result = onCommit.mock.calls[0]?.[0];
    expect(result.audio.length).toBe(16);
    expect(result.sampleRate).toBe(audioIn.format.sampleRate);
    expect(result.durationMs).toBeGreaterThan(0);

    // Buffer is drained after commit.
    expect(audioIn.stats.bufferedBytes).toBe(0);
  });

  it("does not commit when EOM frame arrives with empty buffer", () => {
    const onCommit = vi.fn();
    const audioIn = new AudioInputStream({ onCommit });
    audioIn.handleFrame(pcmFrame(Buffer.alloc(0), MULTIPLEX_FLAG_EOM));
    expect(onCommit).not.toHaveBeenCalled();
    expect(audioIn.stats.commitsEmitted).toBe(0);
  });

  it("counts empty-payload frames as accepted (heartbeats)", () => {
    const audioIn = new AudioInputStream();
    audioIn.handleFrame(pcmFrame(Buffer.alloc(0)));
    expect(audioIn.stats.framesAccepted).toBe(1);
    expect(audioIn.stats.bytesAccepted).toBe(0);
  });

  it("rejects mis-routed frames (wrong streamId) via onInvalidFrame", () => {
    const onInvalidFrame = vi.fn();
    const audioIn = new AudioInputStream({ onInvalidFrame });
    audioIn.handleFrame(pcmFrame(pcm16Bytes([1, 2]), 0, MULTIPLEX_STREAM.AUDIO_OUTPUT));
    expect(onInvalidFrame).toHaveBeenCalledTimes(1);
    expect(audioIn.stats.framesRejected).toBe(1);
    expect(audioIn.stats.bufferedBytes).toBe(0);
  });

  it("rejects PCM frames with odd byte length via onInvalidFrame", () => {
    const onInvalidFrame = vi.fn();
    const audioIn = new AudioInputStream({ onInvalidFrame });
    audioIn.handleFrame(pcmFrame(Buffer.from([0x01, 0x02, 0x03])));
    expect(audioIn.stats.framesRejected).toBe(1);
    expect(audioIn.stats.framesAccepted).toBe(0);
    expect(onInvalidFrame).toHaveBeenCalledTimes(1);
    expect(audioIn.stats.bufferedBytes).toBe(0);
  });

  it("manual commit() returns null when buffer is empty", () => {
    const audioIn = new AudioInputStream();
    expect(audioIn.commit()).toBeNull();
  });

  it("manual commit() returns the buffered audio and resets state", () => {
    const audioIn = new AudioInputStream();
    audioIn.handleFrame(pcmFrame(pcm16Bytes([10, 20, 30, 40])));
    const result = audioIn.commit();
    expect(result).not.toBeNull();
    expect(result!.audio.length).toBe(8);
    expect(audioIn.stats.bufferedBytes).toBe(0);
    expect(audioIn.stats.commitsEmitted).toBe(1);
  });

  it("clear() drops buffered audio without emitting commit", () => {
    const onCommit = vi.fn();
    const audioIn = new AudioInputStream({ onCommit });
    audioIn.handleFrame(pcmFrame(pcm16Bytes([1, 2, 3, 4])));
    audioIn.clear();
    expect(audioIn.stats.bufferedBytes).toBe(0);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("STREAM_ID is AUDIO_INPUT", () => {
    expect(AudioInputStream.STREAM_ID).toBe(MULTIPLEX_STREAM.AUDIO_INPUT);
  });

  it("forwards buffer options (e.g. maxBufferedMs)", () => {
    const audioIn = new AudioInputStream({ maxBufferedMs: 100 });
    expect(audioIn.buffer.maxBufferedMs).toBe(100);
  });

  it("isolates onCommit consumer errors from the stream", () => {
    const audioIn = new AudioInputStream({
      onCommit: () => {
        throw new Error("downstream boom");
      },
    });
    audioIn.handleFrame(pcmFrame(pcm16Bytes([1, 2]), MULTIPLEX_FLAG_EOM));
    // Next commit must still work.
    audioIn.handleFrame(pcmFrame(pcm16Bytes([3, 4]), MULTIPLEX_FLAG_EOM));
    expect(audioIn.stats.commitsEmitted).toBe(2);
  });
});
