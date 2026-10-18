// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bytesToBase64 } from "../../../lib/bytes-base64.ts";
import { RealtimeTalkMediaStreamMeter, RealtimeTalkPcmOutputQueue } from "./audio.ts";

class MockAudioBufferSource {
  buffer: unknown = null;
  readonly connect = vi.fn();
  readonly start = vi.fn();
  readonly stop = vi.fn();
  private ended: (() => void) | null = null;

  addEventListener(type: string, handler: () => void): void {
    if (type === "ended") {
      this.ended = handler;
    }
  }

  emitEnded(): void {
    this.ended?.();
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
  let context: MockOutputAudioContext;
  let queue: RealtimeTalkPcmOutputQueue;
  beforeEach(() => {
    context = new MockOutputAudioContext();
    queue = openQueue(100);
  });
  afterEach(() => vi.unstubAllGlobals());

  function openQueue(sampleRateHz: number) {
    vi.stubGlobal(
      "AudioContext",
      vi.fn(function () {
        return context;
      }),
    );
    const output = new RealtimeTalkPcmOutputQueue();
    output.open(sampleRateHz);
    return output;
  }

  it("preserves ordered playback while the AudioContext advances normally", () => {
    context.currentTime = 1;

    expect(queue.play(silentPcmBase64(100))).toBe("queued");
    context.currentTime = 1.5;
    expect(queue.play(silentPcmBase64(50))).toBe("queued");

    expect(context.sources.map((source) => source.start.mock.calls[0]?.[0])).toEqual([1, 2]);
    expect(queue).toMatchObject({ playbackDelayMs: 1000, isPlaying: true });
  });

  it("queues a thirty-second generated reply without cancelling its tail", () => {
    queue = openQueue(24_000);
    const frame = silentPcmBase64(480);
    for (let index = 0; index < 1_500; index += 1) {
      expect(queue.play(frame)).toBe("queued");
    }
    expect(queue.playbackDelayMs).toBeCloseTo(30_000, -1);
    expect(context.sources).toHaveLength(1_500);
  });

  it("bounds a frozen AudioContext by queued seconds before allocating another source", () => {
    expect(queue.play(silentPcmBase64(5_600))).toBe("queued");
    expect(queue.play(silentPcmBase64(500))).toBe("overflow");

    expect(context.sources).toHaveLength(1);
    expect(queue.playbackDelayMs).toBe(56_000);
  });

  it.each([
    ["oversized", "!".repeat(30_000), "overflow"],
    ["malformed", "!!!", "ignored"],
  ])("rejects %s frames before allocating a source", (_kind, frame, result) => {
    expect(queue.play(frame)).toBe(result);
    expect(context.sources).toHaveLength(0);
  });

  it("hard-caps source ownership across ten thousand suspended-context chunks", () => {
    queue = openQueue(48_000);
    const results = { queued: 0, overflow: 0, ignored: 0 };
    const frame = silentPcmBase64(1);
    for (let index = 0; index < 10_000; index += 1) {
      results[queue.play(frame)] += 1;
    }
    expect(results).toEqual({ queued: 4_096, overflow: 5_904, ignored: 0 });
    expect(context.sources).toHaveLength(4_096);
  });

  it("releases source ownership on ended", () => {
    queue = openQueue(48_000);
    const chunk = silentPcmBase64(1);

    for (let index = 0; index < 4_096; index += 1) {
      expect(queue.play(chunk)).toBe("queued");
    }
    expect(queue.play(chunk)).toBe("overflow");

    context.sources[0]?.emitEnded();

    expect(queue.play(chunk)).toBe("queued");
    expect(context.sources).toHaveLength(4_097);
  });

  it("stops idempotently and isolates late ended events from replacement playback", () => {
    const chunk = silentPcmBase64(100);

    expect(queue.play(chunk)).toBe("queued");
    const oldSource = context.sources[0];
    context.currentTime = 0.25;
    queue.stop();
    queue.stop();

    expect(oldSource?.stop).toHaveBeenCalledOnce();
    expect(queue).toMatchObject({ isPlaying: false, playbackDelayMs: 0 });

    expect(queue.play(chunk)).toBe("queued");
    const replacementSource = context.sources[1];
    oldSource?.emitEnded();

    expect(queue).toMatchObject({ isPlaying: true, playbackDelayMs: 1000 });
    expect(replacementSource?.stop).not.toHaveBeenCalled();
  });
});
