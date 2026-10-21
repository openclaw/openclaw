import { vi } from "vitest";

class MockAudioBufferSource {
  buffer: unknown = null;
  readonly addEventListener = vi.fn();
  readonly connect = vi.fn();
  readonly start = vi.fn();
  readonly stop = vi.fn();
}

const audioNode = () => ({ connect: vi.fn(), disconnect: vi.fn() });

export function createAudioFixture() {
  const processors: Array<
    ReturnType<typeof audioNode> & {
      onaudioprocess:
        | ((event: { inputBuffer: { getChannelData: (channel: number) => Float32Array } }) => void)
        | null;
    }
  > = [];
  const inputSinks: Array<ReturnType<typeof audioNode> & { gain: { value: number } }> = [];
  const createdSources: MockAudioBufferSource[] = [];

  class AudioContextBase {
    readonly destination = {};
    readonly close = vi.fn(async () => undefined);
    createMediaStreamSource = audioNode;

    createScriptProcessor() {
      const processor: (typeof processors)[number] = { ...audioNode(), onaudioprocess: null };
      processors.push(processor);
      return processor;
    }

    createGain() {
      const sink = { ...audioNode(), gain: { value: 1 } };
      inputSinks.push(sink);
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
      createdSources.push(source);
      return source;
    }
  }
  return { AudioContextBase, processors, inputSinks, createdSources };
}
