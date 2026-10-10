// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
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
});

describe("RealtimeTalkPcmOutputQueue", () => {
  it("ignores malformed base64 frames instead of throwing", () => {
    const context = new MockOutputAudioContext();
    const queue = new RealtimeTalkPcmOutputQueue();

    // Short enough to pass the size gate, invalid enough to fail atob.
    expect(queue.play("!!!", context as unknown as AudioContext, 100)).toBe("ignored");
    expect(context.sources).toHaveLength(0);
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
