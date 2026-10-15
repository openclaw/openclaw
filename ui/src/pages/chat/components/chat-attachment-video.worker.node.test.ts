// @vitest-environment node
import type { StreamTargetChunk } from "mediabunny";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VideoCompressionRequest, VideoCompressionResponse } from "./chat-attachment-video.ts";

const encoder = vi.hoisted(() => ({
  attempts: [] as StreamTargetChunk[][],
  writes: 0,
}));

vi.mock("mediabunny", () => {
  class BufferTarget {
    buffer: ArrayBuffer | null = null;
  }
  class StreamTarget {
    constructor(readonly writable: WritableStream<StreamTargetChunk>) {}
  }
  class Output {
    constructor(readonly options: { target: BufferTarget | StreamTarget }) {}
  }
  return {
    ALL_FORMATS: [],
    BlobSource: vi.fn(),
    BufferTarget,
    StreamTarget,
    Output,
    Input: class {
      async getVideoTracks() {
        return [{ getDisplayWidth: async () => 320, getDisplayHeight: async () => 180 }];
      }
      async getAudioTracks() {
        return [];
      }
      async computeDuration() {
        return 1;
      }
      dispose() {}
    },
    Mp4OutputFormat: vi.fn(),
    WebMOutputFormat: vi.fn(),
    Quality: vi.fn(),
    canEncodeVideo: async () => true,
    canEncodeAudio: async () => true,
    Conversion: {
      async init({ output }: { output: Output }) {
        const chunks = encoder.attempts.shift()!;
        let canceled = false;
        return {
          isValid: true,
          discardedTracks: [],
          async cancel() {
            canceled = true;
          },
          async execute() {
            const target = output.options.target;
            const writer = target instanceof StreamTarget ? target.writable.getWriter() : null;
            const length = Math.max(...chunks.map((chunk) => chunk.position + chunk.data.length));
            const bytes = writer ? null : new Uint8Array(length);
            for (const chunk of chunks) {
              encoder.writes += 1;
              if (writer) {
                await writer.write(chunk);
              } else {
                bytes!.set(chunk.data, chunk.position);
              }
              if (canceled) {
                throw new Error("Conversion canceled");
              }
            }
            if (writer) {
              await writer.close();
            } else if (target instanceof BufferTarget) {
              target.buffer = bytes!.buffer;
            }
          },
        };
      },
    },
  };
});

beforeEach(() => {
  vi.resetModules();
  encoder.attempts = [];
  encoder.writes = 0;
});
afterEach(() => vi.unstubAllGlobals());

async function compress(): Promise<VideoCompressionResponse> {
  let receive!: (event: MessageEvent<VideoCompressionRequest>) => void;
  vi.stubGlobal("addEventListener", (_type: string, listener: typeof receive) => {
    receive = listener;
  });
  const result = new Promise<VideoCompressionResponse>((resolve) => {
    vi.stubGlobal("postMessage", (message: VideoCompressionResponse) => {
      if (message.type !== "progress") {
        resolve(message);
      }
    });
  });
  await import("./chat-attachment-video.worker.ts");
  receive(
    new MessageEvent("message", {
      data: { file: new File(["source"], "screen.mp4"), maxBytes: 100_000 },
    }),
  );
  return result;
}

it("preserves positional header rewrites without publishing unused capacity", async () => {
  encoder.attempts = [
    [
      { type: "write", data: new Uint8Array([0, 0, 3, 4]), position: 0 },
      { type: "write", data: new Uint8Array([1, 2]), position: 0 },
    ],
  ];
  const result = await compress();
  expect(result.type).toBe("ready");
  if (result.type !== "ready") {
    throw new Error("Expected a prepared file");
  }
  expect(result.file.name).toBe("screen-compressed.mp4");
  expect(result.file.type).toBe("video/mp4");
  expect([...new Uint8Array(await result.file.arrayBuffer())]).toEqual([1, 2, 3, 4]);
});

it("retries a measured overshoot and publishes only the smaller attempt", async () => {
  encoder.attempts = [
    [{ type: "write", data: new Uint8Array(150_000), position: 0 }],
    [{ type: "write", data: new Uint8Array([7, 8, 9]), position: 0 }],
  ];
  const result = await compress();
  expect(result.type).toBe("ready");
  if (result.type !== "ready") {
    throw new Error("Expected a prepared file");
  }
  expect([...new Uint8Array(await result.file.arrayBuffer())]).toEqual([7, 8, 9]);
  expect(encoder.attempts).toHaveLength(0);
});

it("stops encoding as soon as output exceeds twice the upload budget", async () => {
  const chunks: StreamTargetChunk[] = [
    { type: "write", data: new Uint8Array(200_001), position: 0 },
    { type: "write", data: new Uint8Array(100_000), position: 200_001 },
  ];
  encoder.attempts = [chunks, chunks];
  const result = await compress();
  expect(encoder.writes).toBe(1);
  expect(result).toEqual({ type: "error", reason: "too-large" });
});
