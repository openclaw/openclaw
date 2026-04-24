import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_INPUT_FORMAT,
  RealtimeInputBuffer,
  pcm16BytesToMs,
  pcm16PeakAmplitude,
} from "./input-buffer.js";

/** Build a PCM16 LE buffer of `samples` samples, each at `amplitude`. */
function pcmTone(samples: number, amplitude: number): Buffer {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(amplitude, i * 2);
  }
  return buf;
}

/** Convert ms at default 16 kHz to PCM16 LE byte length. */
function msAt16k(ms: number): number {
  return Math.round((ms * 16000) / 1000) * 2;
}

describe("pcm16PeakAmplitude / pcm16BytesToMs", () => {
  it("returns 0 for empty buffer", () => {
    expect(pcm16PeakAmplitude(Buffer.alloc(0))).toBe(0);
    expect(pcm16BytesToMs(0, 16000)).toBe(0);
  });

  it("returns peak of |samples|", () => {
    const buf = Buffer.alloc(8);
    buf.writeInt16LE(100, 0);
    buf.writeInt16LE(-300, 2);
    buf.writeInt16LE(50, 4);
    buf.writeInt16LE(-10, 6);
    expect(pcm16PeakAmplitude(buf)).toBe(300);
  });

  it("converts byte length to ms at sample rate", () => {
    expect(pcm16BytesToMs(32_000, 16_000)).toBe(1000); // 16k samples = 1s at 16 kHz
    expect(pcm16BytesToMs(48_000, 24_000)).toBe(1000);
    expect(pcm16BytesToMs(0, 0)).toBe(0);
  });
});

describe("RealtimeInputBuffer", () => {
  it("appends and reports buffered duration in ms", () => {
    const buf = new RealtimeInputBuffer();
    buf.append(pcmTone(1600, 0)); // 100 ms at 16 kHz
    buf.append(pcmTone(800, 0)); // 50 ms
    expect(buf.getBufferedBytes()).toBe(msAt16k(150));
    expect(buf.getBufferedDurationMs()).toBeCloseTo(150, 5);
  });

  it("rejects odd-length PCM chunks", () => {
    const buf = new RealtimeInputBuffer();
    expect(() => buf.append(Buffer.from([0]))).toThrow(/even byte length/);
  });

  it("rejects non-buffer input", () => {
    const buf = new RealtimeInputBuffer();
    // @ts-expect-error — runtime guard
    expect(() => buf.append("audio")).toThrow(TypeError);
  });

  it("ignores empty chunks silently", () => {
    const buf = new RealtimeInputBuffer();
    buf.append(Buffer.alloc(0));
    expect(buf.getBufferedBytes()).toBe(0);
  });

  it("commit returns concatenated audio and clears state", () => {
    const buf = new RealtimeInputBuffer();
    buf.append(pcmTone(160, 5));
    buf.append(pcmTone(160, 6));
    const result = buf.commit();
    expect(result.sampleRate).toBe(16000);
    expect(result.audio.length).toBe(640);
    expect(result.audio.readInt16LE(0)).toBe(5);
    expect(result.audio.readInt16LE(320)).toBe(6);
    expect(result.durationMs).toBeCloseTo((320 * 1000) / 16000, 5);
    expect(buf.getBufferedBytes()).toBe(0);
  });

  it("commit returns a detached buffer (mutations don't affect future state)", () => {
    const buf = new RealtimeInputBuffer();
    buf.append(pcmTone(160, 7));
    const r = buf.commit();
    r.audio[0] = 0;
    buf.append(pcmTone(160, 8));
    const r2 = buf.commit();
    expect(r2.audio.readInt16LE(0)).toBe(8);
  });

  it("clear discards data without emitting", () => {
    const buf = new RealtimeInputBuffer();
    buf.append(pcmTone(160, 1));
    buf.clear();
    expect(buf.getBufferedBytes()).toBe(0);
  });

  it("evicts oldest data when maxBufferedMs exceeded (whole-chunk drop)", () => {
    const buf = new RealtimeInputBuffer({ maxBufferedMs: 100 });
    buf.append(pcmTone(800, 0)); // 50 ms
    buf.append(pcmTone(800, 0)); // 50 ms (total 100 ms — at cap)
    buf.append(pcmTone(800, 0)); // 50 ms — should evict first chunk
    expect(buf.getBufferedDurationMs()).toBeCloseTo(100, 5);
    expect(buf.getBufferedBytes()).toBe(msAt16k(100));
  });

  it("evicts via head trim when overflow is partial", () => {
    const buf = new RealtimeInputBuffer({ maxBufferedMs: 100 });
    buf.append(pcmTone(1600, 0)); // 100 ms — full
    buf.append(pcmTone(160, 0)); // 10 ms — overflow by 10 ms
    expect(buf.getBufferedDurationMs()).toBeCloseTo(100, 5);
  });

  it("rejects unsupported formats", () => {
    expect(
      () =>
        new RealtimeInputBuffer({
          // @ts-expect-error invalid format type
          format: { type: "opus", sampleRate: 48000, channels: 1 },
        }),
    ).toThrow(/only mono pcm16 supported/);
    expect(() => new RealtimeInputBuffer({ format: { ...DEFAULT_INPUT_FORMAT, sampleRate: 0 } })).toThrow(
      /sampleRate/,
    );
  });

  it("triggers VAD onSpeechStarted after sustained non-silence", () => {
    let now = 0;
    const onSpeechStarted = vi.fn();
    const buf = new RealtimeInputBuffer({
      vadSilenceThreshold: 100,
      vadSpeechDurationMs: 50,
      onSpeechStarted,
      now: () => now,
    });

    // Below threshold => stays silent.
    now = 0;
    buf.append(pcmTone(160, 10));
    expect(onSpeechStarted).not.toHaveBeenCalled();
    expect(buf.isSpeaking()).toBe(false);

    // Loud chunk at t=10 starts streak; 60 ms later threshold reached.
    now = 10;
    buf.append(pcmTone(160, 5000));
    now = 70;
    buf.append(pcmTone(160, 5000));
    expect(onSpeechStarted).toHaveBeenCalledTimes(1);
    expect(buf.isSpeaking()).toBe(true);
  });

  it("triggers VAD onSpeechStopped after sustained silence following speech", () => {
    let now = 0;
    const onSpeechStarted = vi.fn();
    const onSpeechStopped = vi.fn();
    const buf = new RealtimeInputBuffer({
      vadSilenceThreshold: 100,
      vadSpeechDurationMs: 0,
      vadSilenceDurationMs: 200,
      onSpeechStarted,
      onSpeechStopped,
      now: () => now,
    });

    now = 0;
    buf.append(pcmTone(160, 5000));
    now = 10;
    buf.append(pcmTone(160, 5000));
    expect(onSpeechStarted).toHaveBeenCalledTimes(1);

    // Silence streak begins; not enough time yet.
    now = 20;
    buf.append(pcmTone(160, 0));
    expect(onSpeechStopped).not.toHaveBeenCalled();
    now = 100;
    buf.append(pcmTone(160, 0));
    expect(onSpeechStopped).not.toHaveBeenCalled();
    now = 230;
    buf.append(pcmTone(160, 0));
    expect(onSpeechStopped).toHaveBeenCalledTimes(1);
    expect(buf.isSpeaking()).toBe(false);
  });

  it("interrupting silence resets the silence streak", () => {
    let now = 0;
    const onSpeechStopped = vi.fn();
    const buf = new RealtimeInputBuffer({
      vadSilenceThreshold: 100,
      vadSpeechDurationMs: 0,
      vadSilenceDurationMs: 100,
      onSpeechStarted: () => undefined,
      onSpeechStopped,
      now: () => now,
    });
    now = 0;
    buf.append(pcmTone(160, 5000));
    now = 50;
    buf.append(pcmTone(160, 0));
    now = 80;
    buf.append(pcmTone(160, 5000)); // burst breaks streak
    now = 130;
    buf.append(pcmTone(160, 0));
    now = 175; // only 45 ms of silence so far — below 100
    buf.append(pcmTone(160, 0));
    expect(onSpeechStopped).not.toHaveBeenCalled();
  });

  it("clear() does NOT fire onSpeechStopped", () => {
    let now = 0;
    const onSpeechStopped = vi.fn();
    const buf = new RealtimeInputBuffer({
      vadSilenceThreshold: 100,
      vadSpeechDurationMs: 0,
      onSpeechStopped,
      now: () => now,
    });
    buf.append(pcmTone(160, 5000));
    expect(buf.isSpeaking()).toBe(true);
    buf.clear();
    expect(buf.isSpeaking()).toBe(false);
    expect(onSpeechStopped).not.toHaveBeenCalled();
  });
});
