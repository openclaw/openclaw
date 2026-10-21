// @vitest-environment node
import { expectDefined } from "@openclaw/normalization-core";
import type { StreamTargetChunk } from "mediabunny";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VideoCompressionResponse } from "./chat-attachment-video.ts";

const encoder = vi.hoisted(() => ({ attempts: [] as StreamTargetChunk[][], writes: 0 }));

vi.mock("mediabunny", () => {
  class StreamTarget {
    constructor(readonly writable: WritableStream<StreamTargetChunk>) {}
  }
  class Output {
    constructor(readonly options: { target: StreamTarget }) {}
  }
  return {
    ALL_FORMATS: [],
    BlobSource: vi.fn(),
    StreamTarget,
    Output,
    Input: class {
      getVideoTracks = async () => [
        { getDisplayWidth: async () => 320, getDisplayHeight: async () => 180 },
      ];
      getAudioTracks = async () => [];
      computeDuration = async () => 1;
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
            const writer = output.options.target.writable.getWriter();
            for (const chunk of chunks) {
              encoder.writes += 1;
              await writer.write(chunk);
              if (canceled) {
                throw new Error("Conversion canceled");
              }
            }
            await writer.close();
          },
        };
      },
    },
  };
});

beforeEach(() => {
  vi.resetModules();
  encoder.writes = 0;
});
afterEach(() => vi.unstubAllGlobals());

function writeChunk(data: number[] | number, position = 0): StreamTargetChunk {
  const bytes = typeof data === "number" ? new Uint8Array(data) : Uint8Array.from(data);
  return { type: "write", data: bytes, position };
}

async function compress(attempts: StreamTargetChunk[][]): Promise<VideoCompressionResponse> {
  encoder.attempts = attempts;
  const workerScope = new EventTarget();
  for (const method of ["addEventListener", "removeEventListener"] as const) {
    vi.stubGlobal(method, workerScope[method].bind(workerScope));
  }
  const result = new Promise<VideoCompressionResponse>((resolve) => {
    vi.stubGlobal("postMessage", (message: VideoCompressionResponse) => {
      if (message.type !== "progress") {
        resolve(message);
      }
    });
  });
  await import("./chat-attachment-video.worker.ts");
  const file = new File([], "screen.mp4");
  workerScope.dispatchEvent(new MessageEvent("message", { data: { file, maxBytes: 100_000 } }));
  return result;
}

async function prepared(attempts: StreamTargetChunk[][]) {
  const result = await compress(attempts);
  return expectDefined(result.type === "ready" ? result.file : undefined, "prepared video");
}

it("preserves positional header rewrites without publishing unused capacity", async () => {
  const file = await prepared([[writeChunk([0, 0, 3, 4]), writeChunk([1, 2])]]);
  expect(file).toMatchObject({ name: "screen-compressed.mp4", type: "video/mp4" });
  expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1, 2, 3, 4]);
});

it("retries a measured overshoot and publishes only the smaller attempt", async () => {
  const file = await prepared([[writeChunk(150_000)], [writeChunk([7, 8, 9])]]);
  expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([7, 8, 9]);
  expect(encoder.attempts).toHaveLength(0);
});

it("stops encoding as soon as output exceeds twice the upload budget", async () => {
  const chunks = [writeChunk(200_001), writeChunk(100_000, 200_001)];
  const result = await compress([chunks, chunks]);
  expect(encoder.writes).toBe(1);
  expect(result).toEqual({ type: "error", reason: "too-large" });
});
