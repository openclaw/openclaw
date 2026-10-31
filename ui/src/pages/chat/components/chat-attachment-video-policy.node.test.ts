// @vitest-environment node
import { readFileSync } from "node:fs";
import { InputAudioTrack, InputVideoTrack, type ConversionOptions } from "mediabunny";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VideoCompressionRequest, VideoCompressionResponse } from "./chat-attachment-video.ts";

const capabilities = vi.hoisted(() => ({
  aacEncoder: true,
  encoder: true,
  decoder: true,
  extraDiscard: false,
  execute: vi.fn(),
}));
vi.mock("mediabunny", async (importOriginal) => {
  const media = await importOriginal<typeof import("mediabunny")>();
  return {
    ...media,
    canEncodeVideo: async () => capabilities.encoder,
    canEncodeAudio: async (codec: string) =>
      capabilities.encoder && (codec !== "aac" || capabilities.aacEncoder),
    Conversion: {
      async init(options: ConversionOptions) {
        const tracks = await options.input.getTracks();
        const discardedTracks = [];
        const utilizedTracks = [];
        for (const track of tracks) {
          if (track.isAudioTrack() && typeof options.audio === "function") {
            const selection = await options.audio(track, track.number);
            if (selection && !Array.isArray(selection) && selection.discard) {
              discardedTracks.push({ track, reason: "discarded_by_user" });
              continue;
            }
            expect(selection).toMatchObject({
              codec: capabilities.aacEncoder ? "aac" : "opus",
              forceTranscode: true,
            });
          }
          utilizedTracks.push(track);
        }
        expect(options.tracks).toBe("all");
        expect(options.video).toMatchObject({
          codec: capabilities.aacEncoder ? "avc" : "vp9",
          forceTranscode: true,
        });
        if (capabilities.extraDiscard) {
          discardedTracks.push({ track: tracks[1]!, reason: "undecodable_source_codec" });
        }
        return {
          isValid: true,
          utilizedTracks,
          discardedTracks,
          cancel: async () => {},
          execute: capabilities.execute,
        };
      },
    },
  };
});

const source = readFileSync(
  new URL("../../../e2e/fixtures/video-compatible-copy.mp4", import.meta.url),
);
beforeEach(() => {
  vi.resetModules();
  Object.assign(capabilities, {
    aacEncoder: true,
    encoder: true,
    decoder: true,
    extraDiscard: false,
  });
  capabilities.execute.mockReset().mockRejectedValue(new Error("controlled encoding endpoint"));
  vi.spyOn(InputVideoTrack.prototype, "canDecode").mockImplementation(async function (
    this: InputVideoTrack,
  ) {
    return capabilities.decoder && (await this.getCodec()) !== null;
  });
  vi.spyOn(InputAudioTrack.prototype, "canDecode").mockImplementation(async function (
    this: InputAudioTrack,
  ) {
    return capabilities.decoder && (await this.getCodec()) !== null;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function run(bytes = source, omission?: VideoCompressionRequest["omission"]) {
  vi.resetModules();
  const scope = new EventTarget();
  for (const method of ["addEventListener", "removeEventListener"] as const) {
    vi.stubGlobal(method, scope[method].bind(scope));
  }
  const done = Promise.withResolvers<VideoCompressionResponse>();
  vi.stubGlobal("postMessage", (result: VideoCompressionResponse) => {
    if (result.type !== "progress") {
      done.resolve(result);
    }
  });
  await import("./chat-attachment-video.worker.ts");
  scope.dispatchEvent(
    new MessageEvent("message", {
      data: {
        file: new File([new Uint8Array(bytes)], "recording.mov"),
        maxBytes: 524288,
        omission,
      },
    }),
  );
  return done.promise;
}

it.each([true, false])(
  "offers precisely track 3 without encoding (AAC encoder=%s)",
  async (aacEncoder) => {
    capabilities.aacEncoder = aacEncoder;
    expect(await run()).toEqual({ type: "compatible-copy", omission: { omitApacTrackId: 3 } });
    expect(capabilities.execute).not.toHaveBeenCalled();
    expect(await run(source, { omitApacTrackId: 2 })).toEqual({
      type: "error",
      reason: "unsupported",
    });
    expect(capabilities.execute).not.toHaveBeenCalled();
    await run(source, { omitApacTrackId: 3 });
    expect(capabilities.execute).toHaveBeenCalledOnce();
  },
);

it.each(["decoder", "encoder", "extraDiscard"] as const)(
  "refuses when %s prevents the exact retained inventory",
  async (caseName) => {
    if (caseName === "extraDiscard") {
      capabilities.extraDiscard = true;
    } else {
      capabilities[caseName] = false;
    }
    expect(await run()).toEqual({ type: "error", reason: "unsupported" });
    expect(capabilities.execute).not.toHaveBeenCalled();
  },
);

it.each(["HDR", "unknown color"])("refuses separate fidelity boundary: %s", async (name) => {
  if (name === "HDR") {
    vi.spyOn(InputVideoTrack.prototype, "hasHighDynamicRange").mockResolvedValue(true);
  } else {
    vi.spyOn(InputVideoTrack.prototype, "getColorSpace").mockResolvedValue({});
  }
  expect(await run()).toEqual({ type: "error", reason: "fidelity" });
});

it("refuses unsupported video instead of offering an audio-only copy", async () => {
  vi.spyOn(InputVideoTrack.prototype, "getCodec").mockResolvedValue(null);
  expect(await run()).toEqual({ type: "error", reason: "unsupported" });
});

it("refuses APAC-only audio and an unapproved unknown audio track", async () => {
  const apacOnly = Buffer.from(source);
  apacOnly.write("apac", apacOnly.indexOf("mp4a"));
  apacOnly.write("free", apacOnly.indexOf("esds"));
  expect(await run(apacOnly)).toEqual({ type: "error", reason: "unsupported" });
  const unknown = Buffer.from(source);
  unknown.write("zzzz", unknown.indexOf("apac"));
  expect(await run(unknown, { omitApacTrackId: 3 })).toEqual({
    type: "error",
    reason: "unsupported",
  });
});

it("refuses a container track omitted from the library projection", async () => {
  const trackStart = source.indexOf("trak") - 4;
  const extra = Buffer.from(
    source.subarray(trackStart, trackStart + source.readUInt32BE(trackStart)),
  );
  extra.writeUInt32BE(99, extra.indexOf("tkhd") + 16);
  extra.write("meta", extra.indexOf("vide"));
  const start = source.indexOf("moov") - 4;
  const size = source.readUInt32BE(start);
  const bytes = Buffer.concat([
    source.subarray(0, start + size),
    extra,
    source.subarray(start + size),
  ]);
  bytes.writeUInt32BE(size + extra.length, start);
  expect(await run(bytes)).toEqual({ type: "error", reason: "unsupported" });
  expect(capabilities.execute).not.toHaveBeenCalled();
});
