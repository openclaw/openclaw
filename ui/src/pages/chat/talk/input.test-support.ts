import { afterEach, beforeEach, onTestFinished, vi } from "vitest";
import { RealtimeTalkInputOwner } from "./input.ts";

export const mockAudioNode = () => ({ connect: vi.fn(), disconnect: vi.fn() });
export type MockAudioProcessor = ReturnType<typeof mockAudioNode> & {
  onaudioprocess:
    | ((event: { inputBuffer: { getChannelData: (channel: number) => Float32Array } }) => void)
    | null;
};
export type MockAudioSink = ReturnType<typeof mockAudioNode> & { gain: { value: number } };

export class MockAudioBufferSource {
  buffer: unknown = null;
  readonly addEventListener = vi.fn();
  readonly connect = vi.fn();
  readonly start = vi.fn();
  readonly stop = vi.fn();
}

export function createPcmAudioContext(
  processors: MockAudioProcessor[],
  sinks: MockAudioSink[],
  sources: MockAudioBufferSource[],
) {
  return class {
    readonly destination = {};
    readonly close = vi.fn(async () => undefined);

    createMediaStreamSource() {
      return mockAudioNode();
    }

    createScriptProcessor() {
      const processor: MockAudioProcessor = { ...mockAudioNode(), onaudioprocess: null };
      processors.push(processor);
      return processor;
    }

    createGain() {
      const sink = { ...mockAudioNode(), gain: { value: 1 } };
      sinks.push(sink);
      return sink;
    }

    createAnalyser() {
      return {
        fftSize: 0,
        smoothingTimeConstant: 0,
        disconnect: vi.fn(),
        getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0.25),
      };
    }

    createBuffer(_channels: number, length: number, sampleRate: number) {
      const channel = new Float32Array(length);
      return { duration: length / sampleRate, getChannelData: () => channel };
    }

    createBufferSource() {
      const source = new MockAudioBufferSource();
      sources.push(source);
      return source;
    }
  };
}

export class MockDictationAudioContext {
  readonly destination = {};
  readonly sampleRate = 8000;
  readonly close = vi.fn(async () => undefined);
  createMediaStreamSource = mockAudioNode;

  createScriptProcessor(): MockAudioProcessor {
    return { ...mockAudioNode(), onaudioprocess: null };
  }

  createGain() {
    return { ...mockAudioNode(), gain: { value: 1 } };
  }

  createAnalyser() {
    return {
      fftSize: 0,
      smoothingTimeConstant: 0,
      ...mockAudioNode(),
      getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0),
    };
  }
}

export function audioFixture() {
  const track = Object.assign(new EventTarget(), { stop: vi.fn() });
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  return { track, stream };
}

export function cameraFixture(deviceId?: string) {
  const track = Object.assign(new EventTarget(), {
    stop: vi.fn(),
    readyState: "live",
    enabled: true,
    muted: false,
    ...(deviceId ? { getSettings: () => ({ deviceId }) } : {}),
  });
  const stream = {
    getVideoTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  return { track, stream };
}

export function stubMedia(...streams: MediaStream[]) {
  const getUserMedia = vi.fn();
  for (const stream of streams) {
    getUserMedia.mockResolvedValueOnce(stream);
  }
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  return getUserMedia;
}

export async function prepareRealtimeTalkTestInput(
  inputDeviceId?: string,
): Promise<RealtimeTalkInputOwner> {
  const input = new RealtimeTalkInputOwner(() => undefined);
  onTestFinished(() => input.stop());
  await input.open(inputDeviceId);
  return input;
}

export function useRealtimeTalkMicrophoneFixture(): void {
  beforeEach(() => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => {
          const track = Object.assign(new EventTarget(), { stop: vi.fn() });
          return { getTracks: () => [track], getAudioTracks: () => [track] };
        }),
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());
}
