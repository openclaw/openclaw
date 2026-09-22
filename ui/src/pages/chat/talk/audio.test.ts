// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bytesToBase64,
  RealtimeTalkMediaStreamMeter,
  RealtimeTalkPcmOutputQueue,
} from "./audio.ts";

class MockAudioBufferSource {
  buffer: { duration: number } | null = null;
  readonly connect = vi.fn();
  readonly start = vi.fn();
  readonly stop = vi.fn();
  private ended: (() => void) | null = null;
  private finished = false;

  addEventListener(type: string, handler: () => void): void {
    if (type === "ended") {
      this.ended = handler;
    }
  }

  emitEnded(): void {
    this.finished = true;
    this.ended?.();
  }

  /** Fires `ended` once the context clock passes this source's scheduled end. */
  settleAt(currentTime: number): void {
    const startAt = this.start.mock.calls[0]?.[0] as number | undefined;
    if (this.finished || startAt === undefined || this.buffer === null) {
      return;
    }
    if (currentTime >= startAt + this.buffer.duration) {
      this.emitEnded();
    }
  }
}

class MockOutputAudioContext {
  currentTime = 0;
  readonly destination = {};
  readonly sources: MockAudioBufferSource[] = [];

  createBuffer(_channels: number, length: number, sampleRate: number) {
    const channel = new Float32Array(length);
    return {
      duration: length / sampleRate,
      getChannelData: () => channel,
    };
  }

  createBufferSource(): MockAudioBufferSource {
    const source = new MockAudioBufferSource();
    this.sources.push(source);
    return source;
  }

  /**
   * Advances the clock the way a real AudioContext does: sources whose
   * scheduled playback has finished release themselves through `ended`, so
   * pending-source counts reflect queued-ahead audio rather than total frames.
   */
  advanceTo(currentTime: number): void {
    this.currentTime = currentTime;
    for (const source of this.sources) {
      source.settleAt(currentTime);
    }
  }
}

function silentPcmBase64(sampleCount: number): string {
  return bytesToBase64(new Uint8Array(sampleCount * 2));
}

describe("RealtimeTalkMediaStreamMeter", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("samples a WebRTC input stream and resets its level when stopped", () => {
    vi.useFakeTimers();
    const close = vi.fn(async () => undefined);
    const disconnectSource = vi.fn();
    const disconnectAnalyser = vi.fn();
    const analyser = {
      fftSize: 0,
      smoothingTimeConstant: 0,
      disconnect: disconnectAnalyser,
      getFloatTimeDomainData: vi
        .fn()
        .mockImplementationOnce((samples: Float32Array) => samples.fill(0.2))
        .mockImplementation((samples: Float32Array) => samples.fill(0)),
    };
    class MockAudioContext {
      readonly close = close;
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: disconnectSource };
      }
      createAnalyser() {
        return analyser;
      }
    }
    vi.stubGlobal("AudioContext", MockAudioContext);
    const onLevel = vi.fn();
    const meter = new RealtimeTalkMediaStreamMeter(onLevel);

    meter.start({} as MediaStream);
    vi.advanceTimersByTime(3_000);

    expect(onLevel.mock.calls.some(([level]) => level > 0)).toBe(true);
    expect(onLevel).toHaveBeenLastCalledWith(0);
    meter.stop();

    expect(analyser.fftSize).toBe(512);
    expect(onLevel).toHaveBeenLastCalledWith(0);
    expect(disconnectSource).toHaveBeenCalledOnce();
    expect(disconnectAnalyser).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("reclaims its interval when the initial level callback stops it", () => {
    vi.useFakeTimers();
    const close = vi.fn(async () => undefined);
    const disconnectSource = vi.fn();
    const disconnectAnalyser = vi.fn();
    class MockAudioContext {
      readonly close = close;
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: disconnectSource };
      }
      createAnalyser() {
        return {
          fftSize: 0,
          smoothingTimeConstant: 0,
          disconnect: disconnectAnalyser,
          getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0.25),
        };
      }
    }
    vi.stubGlobal("AudioContext", MockAudioContext);
    const onLevel = vi.fn((level: number) => {
      if (level > 0) {
        meter.stop();
      }
    });
    const meter = new RealtimeTalkMediaStreamMeter(onLevel);

    meter.start({} as MediaStream);
    meter.stop();
    meter.stop();
    vi.advanceTimersByTime(1_000);

    expect(vi.getTimerCount()).toBe(0);
    expect(disconnectSource).toHaveBeenCalledOnce();
    expect(disconnectAnalyser).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes an owned AudioContext when analyser setup fails", () => {
    const close = vi.fn(async () => undefined);
    class MockAudioContext {
      readonly close = close;
      createMediaStreamSource() {
        throw new Error("source unavailable");
      }
    }
    vi.stubGlobal("AudioContext", MockAudioContext);
    const onLevel = vi.fn();

    new RealtimeTalkMediaStreamMeter(onLevel).start({} as MediaStream);

    expect(close).toHaveBeenCalledOnce();
    expect(onLevel).toHaveBeenLastCalledWith(0);
  });
});

describe("RealtimeTalkPcmOutputQueue", () => {
  it("preserves ordered playback while the AudioContext advances normally", () => {
    const context = new MockOutputAudioContext();
    context.currentTime = 1;
    const queue = new RealtimeTalkPcmOutputQueue();

    expect(queue.play(silentPcmBase64(100), context as unknown as AudioContext, 100)).toBe(
      "queued",
    );
    context.currentTime = 1.5;
    expect(queue.play(silentPcmBase64(50), context as unknown as AudioContext, 100)).toBe("queued");

    expect(context.sources.map((source) => source.start.mock.calls[0]?.[0])).toEqual([1, 2]);
    expect(queue.queuedUntil).toBe(2.5);
    expect(queue.isPlaying).toBe(true);
  });

  it("bounds a frozen AudioContext by queued seconds before allocating another source", () => {
    const context = new MockOutputAudioContext();
    const queue = new RealtimeTalkPcmOutputQueue();

    expect(queue.play(silentPcmBase64(600), context as unknown as AudioContext, 100)).toBe(
      "queued",
    );
    expect(queue.play(silentPcmBase64(500), context as unknown as AudioContext, 100)).toBe(
      "overflow",
    );

    expect(context.sources).toHaveLength(1);
    expect(queue.queuedUntil).toBe(6);
  });

  it("keeps a relay reply queued while the queued-seconds budget has room", () => {
    // The gateway-relay contract is 960 bytes == 20ms of 24kHz mono PCM16 per
    // browser event (src/gateway/talk/relay/session-create.ts), and one event
    // becomes one source. Providers generate faster than real time -- Gemini
    // 3.1 measures ~3.6x -- so the queue runs ahead of the context clock.
    // 12.5s of speech leaves ~9s queued ahead, inside the 10s budget, so no
    // frame here may be rejected on a frame count.
    const context = new MockOutputAudioContext();
    const queue = new RealtimeTalkPcmOutputQueue();
    const sampleRateHz = 24_000;
    const frameSeconds = 0.02;
    const frame = silentPcmBase64(sampleRateHz * frameSeconds);
    const frameCount = 625;
    const results = new Set<string>();

    for (let index = 0; index < frameCount; index += 1) {
      results.add(queue.play(frame, context as unknown as AudioContext, sampleRateHz));
      context.advanceTo(((index + 1) * frameSeconds) / 3.6);
    }

    expect([...results]).toEqual(["queued"]);
    expect(queue.queuedUntil).toBeCloseTo(frameCount * frameSeconds, 5);
    // Queued further ahead than the 6.4s that 320 pending sources used to buy,
    // and still inside the queued-seconds budget.
    const queuedAheadSeconds = queue.queuedUntil - context.currentTime;
    expect(queuedAheadSeconds).toBeGreaterThan(6.4);
    expect(queuedAheadSeconds).toBeLessThan(10);
  });

  it("rejects an oversized frame before base64 decoding", () => {
    const context = new MockOutputAudioContext();
    const queue = new RealtimeTalkPcmOutputQueue();

    expect(queue.play("!".repeat(3_000), context as unknown as AudioContext, 100)).toBe("overflow");
    expect(context.sources).toHaveLength(0);
  });

  it("ignores malformed base64 frames instead of throwing", () => {
    const context = new MockOutputAudioContext();
    const queue = new RealtimeTalkPcmOutputQueue();

    // Short enough to pass the size gate, invalid enough to fail atob.
    expect(queue.play("!!!", context as unknown as AudioContext, 100)).toBe("ignored");
    expect(context.sources).toHaveLength(0);
  });

  it("hard-caps source ownership across ten thousand suspended-context chunks", () => {
    // Single-sample frames are far below the 20ms relay contract, so they carry
    // almost no audio and the queued-seconds budget never bounds them. The
    // derived source cap is what stops them owning graph nodes.
    const context = new MockOutputAudioContext();
    const queue = new RealtimeTalkPcmOutputQueue();
    let queued = 0;
    let overflowed = 0;

    for (let index = 0; index < 10_000; index += 1) {
      const result = queue.play(silentPcmBase64(1), context as unknown as AudioContext, 48_000);
      if (result === "queued") {
        queued += 1;
      } else if (result === "overflow") {
        overflowed += 1;
      }
    }

    expect(queued).toBe(500);
    expect(overflowed).toBe(9_500);
    expect(context.sources).toHaveLength(500);
    expect(queue.queuedUntil).toBeLessThan(1);
  });

  it("releases source ownership on ended", () => {
    const context = new MockOutputAudioContext();
    const queue = new RealtimeTalkPcmOutputQueue();
    const chunk = silentPcmBase64(1);

    for (let index = 0; index < 500; index += 1) {
      expect(queue.play(chunk, context as unknown as AudioContext, 48_000)).toBe("queued");
    }
    expect(queue.play(chunk, context as unknown as AudioContext, 48_000)).toBe("overflow");

    context.sources[0]?.emitEnded();

    expect(queue.play(chunk, context as unknown as AudioContext, 48_000)).toBe("queued");
    expect(context.sources).toHaveLength(501);
  });

  it("stops idempotently and isolates late ended events from replacement playback", () => {
    const context = new MockOutputAudioContext();
    const queue = new RealtimeTalkPcmOutputQueue();
    const chunk = silentPcmBase64(100);

    expect(queue.play(chunk, context as unknown as AudioContext, 100)).toBe("queued");
    const oldSource = context.sources[0];
    context.currentTime = 0.25;
    queue.stop(context as unknown as AudioContext);
    queue.stop(context as unknown as AudioContext);

    expect(oldSource?.stop).toHaveBeenCalledOnce();
    expect(queue.isPlaying).toBe(false);
    expect(queue.queuedUntil).toBe(0.25);

    expect(queue.play(chunk, context as unknown as AudioContext, 100)).toBe("queued");
    const replacementSource = context.sources[1];
    oldSource?.emitEnded();

    expect(queue.isPlaying).toBe(true);
    expect(queue.queuedUntil).toBe(1.25);
    expect(replacementSource?.stop).not.toHaveBeenCalled();
  });
});
