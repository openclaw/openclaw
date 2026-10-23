import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import type { PlaybackMediaProbeResult } from "./media-probe.js";
import {
  observePlaybackSourceOpen,
  waitForPlaybackSourceCleanup,
} from "./playback-transcode.test-support.js";

const { playbackWarn, probePlaybackMediaFileDescriptor, runFfmpeg } = vi.hoisted(() => ({
  playbackWarn: vi.fn(),
  probePlaybackMediaFileDescriptor: vi.fn(),
  runFfmpeg: vi.fn(),
}));

vi.mock("../infra/fs-safe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/fs-safe.js")>();
  return {
    ...actual,
    openLocalFileSafely: (...args: Parameters<typeof actual.openLocalFileSafely>) =>
      observePlaybackSourceOpen(actual.openLocalFileSafely(...args)),
  };
});

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: (subsystem: string) => ({ subsystem, warn: playbackWarn }),
}));

vi.mock("./ffmpeg-exec.js", () => ({
  runFfmpeg,
}));

vi.mock("./media-probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./media-probe.js")>()),
  probePlaybackMediaFileDescriptor,
}));

let playback: typeof import("./playback-transcode.js");
let tempHome: TempHomeEnv;

beforeAll(async () => {
  vi.resetModules();
  tempHome = await createTempHomeEnv("openclaw-playback-transcode-");
  playback = await import("./playback-transcode.js");
});

afterAll(async () => {
  try {
    await waitForPlaybackSourceCleanup();
    await tempHome.restore();
  } finally {
    vi.doUnmock("../infra/fs-safe.js");
    vi.doUnmock("./ffmpeg-exec.js");
    vi.doUnmock("./media-probe.js");
    vi.resetModules();
  }
});

beforeEach(() => {
  playbackWarn.mockReset();
  runFfmpeg.mockReset();
  probePlaybackMediaFileDescriptor.mockReset();
  probePlaybackMediaFileDescriptor.mockImplementation(async (_fd: number, kind: string) =>
    kind === "audio"
      ? { durationMs: 1000, audioCodec: "pcm_s16le", audioStreamIndex: 0 }
      : {
          durationMs: 1000,
          videoCodec: "vp9",
          videoStreamIndex: 0,
          audioCodec: "opus",
          audioStreamIndex: 1,
        },
  );
});

async function createSource(fileName: string, contents = "source") {
  const fixturePath = path.join(tempHome.home, fileName);
  await fs.writeFile(fixturePath, contents);
  const sourcePath = await fs.realpath(fixturePath);
  const sourceStat = await fs.stat(sourcePath);
  return {
    sourcePath,
    sourceStat: {
      size: sourceStat.size,
      mtimeMs: sourceStat.mtimeMs,
      ctimeMs: sourceStat.ctimeMs,
      exactIdentity: await fs.stat(sourcePath, { bigint: true }),
    },
  };
}

function createGatedFfmpegJob(output: string) {
  const started = createDeferred();
  const gate = createDeferred();
  return {
    started: started.promise,
    release: gate.resolve,
    run: async (args: string[]) => {
      started.resolve();
      await gate.promise;
      await fs.writeFile(args.at(-1) ?? "", output);
      return "";
    },
  };
}

describe("playback transcode policy", () => {
  it.each([
    ["audio/m4a", "audio", "native", "aac"],
    ["audio/mp3", "audio", "native", "mp3"],
    ["audio/mpeg", "audio", "native", "mp3"],
    ["audio/wav", "audio", "native", "pcm_s16le"],
    ["audio/aac", "audio", "transcode", "aac"],
    ["audio/x-caf", "audio", "transcode", "pcm_s16le"],
    ["video/mp4", "video", "native", "h264"],
  ] as const)(
    "classifies accepted $0 $1 as $2 through the public source resolver",
    async (mimeType, kind, expected, codec) => {
      const source = await createSource(`${mimeType.replaceAll("/", "-")}-${codec}`);
      const probe =
        kind === "audio"
          ? { durationMs: 1000, audioCodec: codec, audioStreamIndex: 0 }
          : {
              durationMs: 1000,
              videoCodec: codec,
              videoProfile: codec === "h264" ? "high" : undefined,
              videoPixelFormat: codec === "h264" ? "yuv420p" : undefined,
              videoStreamIndex: 0,
            };

      probePlaybackMediaFileDescriptor.mockResolvedValueOnce(probe);
      await expect(
        playback.resolvePlaybackMetadataForSource({
          ...source,
          mimeType,
          kind,
        }),
      ).resolves.toMatchObject({ playback: expected, durationMs: 1000 });
    },
  );

  it.each([
    ["audio/m4a", "audio", "mov"],
    ["audio/mpeg", "audio", "mp3"],
    ["audio/wav", "audio", "wav"],
    ["audio/aac", "audio", "aac"],
    ["audio/aiff", "audio", "aiff"],
    ["audio/amr", "audio", "amr"],
    ["audio/flac", "audio", "flac"],
    ["audio/ogg", "audio", "ogg"],
    ["audio/webm", "audio", "matroska,webm"],
    ["audio/x-caf", "audio", "caf"],
    ["audio/x-ms-asf", "audio", "asf"],
    ["video/mp4", "video", "mov"],
    ["video/vnd.avi", "video", "avi"],
    ["video/flv", "video", "flv"],
    ["video/matroska", "video", "matroska,webm"],
    ["video/quicktime", "video", "mov"],
    ["video/x-ms-asf", "video", "asf"],
  ] as const)(
    "uses the $2 demuxer for accepted $0 conversion",
    async (mimeType, kind, inputFormat) => {
      const source = await createSource(`demux-${mimeType.replaceAll("/", "-")}`);
      const probe =
        kind === "audio"
          ? { durationMs: 1000, audioCodec: "opus", audioStreamIndex: 0 }
          : { durationMs: 1000, videoCodec: "hevc", videoStreamIndex: 0 };
      probePlaybackMediaFileDescriptor.mockResolvedValueOnce(probe);
      runFfmpeg.mockImplementationOnce(async (args: string[]) => {
        await fs.writeFile(args.at(-1) ?? "", `normalized-${kind}`);
        return "";
      });

      await expect(
        playback.resolvePlaybackTranscode({ ...source, mimeType, kind }),
      ).resolves.toEqual({ kind: "preparing" });
      await waitForPlaybackSourceCleanup();

      const ffmpegArgs = runFfmpeg.mock.calls[0]?.[0] as string[];
      const inputFormatIndex = ffmpegArgs.indexOf("-f");
      expect(ffmpegArgs[inputFormatIndex + 1]).toBe(inputFormat);
      await expect(
        playback.resolvePlaybackTranscode({ ...source, mimeType, kind }),
      ).resolves.toMatchObject(
        kind === "audio"
          ? { kind: "transcoded", contentType: "audio/mp4", extension: ".m4a" }
          : { kind: "transcoded", contentType: "video/mp4", extension: ".mp4" },
      );
    },
  );

  it("does not reuse a rendition after the source file is replaced", async () => {
    const original = await createSource("replaced-cache.mkv", "first-source");
    const params = { ...original, mimeType: "video/x-matroska", kind: "video" as const };
    runFfmpeg.mockImplementation(async (args: string[]) => {
      await fs.writeFile(args.at(-1) ?? "", `rendition-${runFfmpeg.mock.calls.length}`);
      return "";
    });
    await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({ kind: "preparing" });
    await waitForPlaybackSourceCleanup();
    await expect(playback.resolvePlaybackTranscode(params)).resolves.toMatchObject({
      kind: "transcoded",
    });

    await fs.rename(original.sourcePath, `${original.sourcePath}.old`);
    const replacement = await createSource("replaced-cache.mkv", "other-source");
    expect(replacement.sourceStat.exactIdentity.ino).not.toBe(
      original.sourceStat.exactIdentity.ino,
    );
    const replacedParams = { ...params, ...replacement };
    await expect(playback.resolvePlaybackTranscode(replacedParams)).resolves.toEqual({
      kind: "preparing",
    });
    await waitForPlaybackSourceCleanup();
    const result = await playback.resolvePlaybackTranscode(replacedParams);
    expect(runFfmpeg).toHaveBeenCalledTimes(2);
    expect(result.kind).toBe("transcoded");
    if (result.kind !== "transcoded") {
      throw new Error("Expected replacement playback output");
    }
    expect(await fs.readFile(result.path, "utf8")).toBe("rendition-2");
  });
});

describe("resolvePlaybackTranscode", () => {
  it("falls back before ffmpeg when source duration exceeds the transcode limit", async () => {
    const source = await createSource("long-video.mkv");
    probePlaybackMediaFileDescriptor.mockResolvedValueOnce({
      durationMs: 20 * 60 * 1000 + 1,
      videoCodec: "hevc",
      videoStreamIndex: 0,
    });

    await expect(
      playback.resolvePlaybackTranscode({
        ...source,
        mimeType: "video/x-matroska",
        kind: "video",
      }),
    ).resolves.toEqual({ kind: "fallback" });
    expect(runFfmpeg).not.toHaveBeenCalled();
  });

  it("scopes cached codec classification by media kind and MIME", async () => {
    const source = await createSource("dual-track.mp4");
    probePlaybackMediaFileDescriptor
      .mockResolvedValueOnce({ durationMs: 1000, audioCodec: "aac", audioStreamIndex: 1 })
      .mockResolvedValueOnce({
        durationMs: 1000,
        videoCodec: "hevc",
        videoStreamIndex: 0,
        audioCodec: "aac",
        audioStreamIndex: 1,
      });

    await expect(
      playback.resolvePlaybackMetadataForSource({
        ...source,
        mimeType: "audio/mp4",
        kind: "audio",
      }),
    ).resolves.toMatchObject({ playback: "native" });
    await expect(
      playback.resolvePlaybackMetadataForSource({
        ...source,
        mimeType: "video/mp4",
        kind: "video",
      }),
    ).resolves.toMatchObject({ playback: "transcode" });
  });

  it.each([
    ["hevc", undefined],
    ["h264", "native"],
  ] as const)("only advertises native playback for oversized %s media", async (codec, expected) => {
    const source = await createSource(`oversized-${codec}.mp4`);
    await fs.truncate(source.sourcePath, 16 * 1024 * 1024 + 1);
    probePlaybackMediaFileDescriptor.mockResolvedValueOnce({
      durationMs: 1000,
      videoCodec: codec,
      videoProfile: "high",
      videoPixelFormat: "yuv420p",
      videoStreamIndex: 0,
    });

    const currentStat = await fs.stat(source.sourcePath);
    const metadata = await playback.resolvePlaybackMetadataForSource({
      sourcePath: source.sourcePath,
      sourceStat: {
        size: currentStat.size,
        mtimeMs: currentStat.mtimeMs,
        ctimeMs: currentStat.ctimeMs,
        exactIdentity: await fs.stat(source.sourcePath, { bigint: true }),
      },
      mimeType: "video/mp4",
      kind: "video",
    });
    expect(metadata.playback).toBe(expected);
  });

  it("transcodes nonportable H.264 profiles and pixel formats", async () => {
    const source = await createSource("high-10.mp4");
    probePlaybackMediaFileDescriptor.mockResolvedValueOnce({
      durationMs: 1000,
      videoCodec: "h264",
      videoProfile: "high 10",
      videoPixelFormat: "yuv420p10le",
      videoStreamIndex: 0,
    });

    await expect(
      playback.resolvePlaybackMetadataForSource({
        ...source,
        mimeType: "video/mp4",
        kind: "video",
      }),
    ).resolves.toMatchObject({ playback: "transcode" });
  });

  it("transcodes known-incompatible MP4 audio when H.264 profile facts are unknown", async () => {
    const source = await createSource("unknown-profile-opus.mp4");
    probePlaybackMediaFileDescriptor.mockResolvedValueOnce({
      durationMs: 1000,
      videoCodec: "h264",
      videoStreamIndex: 0,
      audioCodec: "opus",
      audioStreamIndex: 1,
    });

    await expect(
      playback.resolvePlaybackMetadataForSource({
        ...source,
        mimeType: "video/mp4",
        kind: "video",
      }),
    ).resolves.toMatchObject({ playback: "transcode" });
  });

  it("does not cache native when a selected audio stream has an unknown codec", async () => {
    const source = await createSource("unknown-audio.mp4");
    probePlaybackMediaFileDescriptor
      .mockResolvedValueOnce({
        durationMs: 1000,
        videoCodec: "h264",
        videoProfile: "high",
        videoPixelFormat: "yuv420p",
        videoStreamIndex: 0,
        audioStreamIndex: 1,
      })
      .mockResolvedValueOnce({
        durationMs: 1000,
        videoCodec: "h264",
        videoProfile: "high",
        videoPixelFormat: "yuv420p",
        videoStreamIndex: 0,
        audioCodec: "opus",
        audioStreamIndex: 1,
      });

    await expect(
      playback.resolvePlaybackMetadataForSource({
        ...source,
        mimeType: "video/mp4",
        kind: "video",
      }),
    ).resolves.toMatchObject({ playback: "native" });
    await expect(
      playback.resolvePlaybackMetadataForSource({
        ...source,
        mimeType: "video/mp4",
        kind: "video",
      }),
    ).resolves.toMatchObject({ playback: "transcode" });
  });

  it("does not cache an inconclusive native codec probe", async () => {
    const source = await createSource("probe-retry.mp4");
    const transcode = createGatedFfmpegJob("normalized-video");
    probePlaybackMediaFileDescriptor.mockResolvedValueOnce(null).mockResolvedValueOnce({
      durationMs: 1000,
      videoCodec: "hevc",
      videoStreamIndex: 0,
      audioCodec: "aac",
      audioStreamIndex: 1,
    });
    runFfmpeg.mockImplementationOnce(transcode.run);
    const params = {
      ...source,
      mimeType: "video/mp4",
      kind: "video" as const,
    };

    try {
      await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
        kind: "passthrough",
      });
      await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
        kind: "preparing",
      });
      await transcode.started;
      expect(runFfmpeg).toHaveBeenCalledOnce();
      expect(probePlaybackMediaFileDescriptor).toHaveBeenCalledTimes(2);
      const finished = waitForPlaybackSourceCleanup();
      transcode.release();
      await finished;
      await expect(playback.resolvePlaybackTranscode(params)).resolves.toMatchObject({
        kind: "transcoded",
      });
    } finally {
      transcode.release();
      await waitForPlaybackSourceCleanup();
    }
  });

  it("shares concurrent inspections and reuses display metadata for a warm source", async () => {
    const source = await createSource("inspection-single-flight.mp4");
    const probeStarted = createDeferred();
    const probeGate = createDeferred<PlaybackMediaProbeResult>();
    probePlaybackMediaFileDescriptor.mockImplementationOnce(async () => {
      probeStarted.resolve();
      return await probeGate.promise;
    });
    const params = {
      ...source,
      mimeType: "video/mp4",
      kind: "video" as const,
    };

    const nativeProbe: PlaybackMediaProbeResult = {
      durationMs: 1000,
      width: 720,
      height: 480,
      videoRotation: 90,
      videoSampleAspectRatio: 4 / 3,
      videoCodec: "h264",
      videoProfile: "high",
      videoPixelFormat: "yuv420p",
      videoStreamIndex: 0,
      audioCodec: "aac",
      audioStreamIndex: 1,
    };
    const first = playback.resolvePlaybackMetadataForSource(params);
    const second = playback.resolvePlaybackMetadataForSource(params);
    try {
      await probeStarted.promise;
      expect(probePlaybackMediaFileDescriptor).toHaveBeenCalledOnce();
      probeGate.resolve(nativeProbe);
      const metadata = { playback: "native", durationMs: 1000, width: 480, height: 960 };
      await expect(Promise.all([first, second])).resolves.toEqual([metadata, metadata]);
      await expect(playback.resolvePlaybackMetadataForSource(params)).resolves.toEqual(metadata);
      expect(probePlaybackMediaFileDescriptor).toHaveBeenCalledOnce();
    } finally {
      probeGate.resolve(nativeProbe);
      await Promise.allSettled([first, second]);
    }
  });

  it("does not cache an inconclusive duration probe for an exotic container", async () => {
    const source = await createSource("duration-retry.mkv");
    probePlaybackMediaFileDescriptor
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ durationMs: 1000, videoCodec: "hevc", videoStreamIndex: 0 });
    runFfmpeg.mockImplementationOnce(async (args: string[]) => {
      await fs.writeFile(args.at(-1) ?? "", "normalized-video");
      return "";
    });
    const params = {
      ...source,
      mimeType: "video/x-matroska",
      kind: "video" as const,
    };

    await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
      kind: "fallback",
    });
    await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
      kind: "preparing",
    });
    await waitForPlaybackSourceCleanup();
    expect(runFfmpeg).toHaveBeenCalledOnce();
    await expect(playback.resolvePlaybackTranscode(params)).resolves.toMatchObject({
      kind: "transcoded",
    });
  });

  it("transcodes HEVC-in-MP4 and reuses its cached codec classification", async () => {
    const source = await createSource("hevc.mp4");
    const transcode = createGatedFfmpegJob("normalized-video");
    probePlaybackMediaFileDescriptor.mockResolvedValueOnce({
      durationMs: 1000,
      videoCodec: "hevc",
      videoStreamIndex: 2,
      audioCodec: "aac",
      audioStreamIndex: 3,
    });
    runFfmpeg.mockImplementationOnce(transcode.run);
    const params = {
      ...source,
      mimeType: "video/mp4",
      kind: "video" as const,
    };

    try {
      await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
        kind: "preparing",
      });
      await transcode.started;
      expect(runFfmpeg).toHaveBeenCalledOnce();
      await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
        kind: "preparing",
      });
      expect(probePlaybackMediaFileDescriptor).toHaveBeenCalledOnce();
      const finished = waitForPlaybackSourceCleanup();
      transcode.release();
      await finished;
      await expect(playback.resolvePlaybackTranscode(params)).resolves.toMatchObject({
        kind: "transcoded",
      });
      expect(runFfmpeg.mock.calls[0]?.[0]).toEqual(
        expect.arrayContaining(["-f", "mov", "-map", "0:2", "-map", "0:3", "-c:v", "libx264"]),
      );
    } finally {
      transcode.release();
      await waitForPlaybackSourceCleanup();
    }
  });

  it("single-flights MIME aliases that target the same cached rendition", async () => {
    const source = await createSource("alias-audio.mp4");
    const transcode = createGatedFfmpegJob("normalized-audio");
    probePlaybackMediaFileDescriptor.mockResolvedValue({
      durationMs: 1000,
      audioCodec: "opus",
      audioStreamIndex: 0,
    });
    runFfmpeg.mockImplementationOnce(transcode.run);
    const base = {
      ...source,
      kind: "audio" as const,
    };

    try {
      await expect(
        Promise.all([
          playback.resolvePlaybackTranscode({ ...base, mimeType: "audio/mp4" }),
          playback.resolvePlaybackTranscode({ ...base, mimeType: "audio/x-m4a" }),
        ]),
      ).resolves.toEqual([{ kind: "preparing" }, { kind: "preparing" }]);
      await transcode.started;
      expect(runFfmpeg).toHaveBeenCalledOnce();
      const finished = waitForPlaybackSourceCleanup();
      transcode.release();
      await finished;
      await expect(
        playback.resolvePlaybackTranscode({ ...base, mimeType: "audio/mp4" }),
      ).resolves.toMatchObject({
        kind: "transcoded",
        contentType: "audio/mp4",
        extension: ".m4a",
      });
    } finally {
      transcode.release();
      await waitForPlaybackSourceCleanup();
    }
  });

  it("single-flights concurrent requests and reuses the deterministic store entry", async () => {
    const source = await createSource("single-flight.mkv");
    const transcode = createGatedFfmpegJob("normalized-video");
    runFfmpeg.mockImplementation(transcode.run);

    const params = {
      ...source,
      mimeType: "video/x-matroska",
      kind: "video" as const,
    };
    try {
      await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
        kind: "preparing",
      });
      await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
        kind: "preparing",
      });
      await transcode.started;
      expect(runFfmpeg).toHaveBeenCalledOnce();
      const finished = waitForPlaybackSourceCleanup();
      transcode.release();
      await finished;

      const resolved = await playback.resolvePlaybackTranscode(params);
      expect(runFfmpeg).toHaveBeenCalledOnce();
      expect(resolved).toMatchObject({
        kind: "transcoded",
        contentType: "video/mp4",
        extension: ".mp4",
      });
      if (resolved.kind !== "transcoded") {
        throw new Error("expected cached playback output");
      }
      expect(resolved.path).toContain(`${path.sep}media${path.sep}playback-transcode${path.sep}`);
      expect(path.basename(resolved.path)).toMatch(/^v2-[a-f0-9]{64}\.mp4$/u);
      expect(await fs.readFile(resolved.path, "utf8")).toBe("normalized-video");
      expect(runFfmpeg.mock.calls[0]?.[0]).toEqual(
        expect.arrayContaining([
          "-max_alloc",
          String(256 * 1024 * 1024),
          "-filter_threads",
          "2",
          "-protocol_whitelist",
          "file",
          "-f",
          "matroska,webm",
          "-max_pixels",
          String(4096 * 4096),
          "-threads",
          "2",
          "-map",
          "0:0",
          "-map",
          "0:1",
          "-t",
          String(20 * 60),
          "-c:v",
          "libx264",
          "-c:a",
          "aac",
          "-movflags",
          "+faststart",
          "-fs",
          String(16 * 1024 * 1024 + 1),
        ]),
      );
    } finally {
      transcode.release();
      await waitForPlaybackSourceCleanup();
    }
  });

  it.each([false, true])(
    "reports output close failures without replacing the probe outcome (probe fails=%s)",
    async (probeFails) => {
      const source = await createSource(`output-close-${probeFails}.mkv`);
      const closeError = new Error("output close failed");
      const probeError = new Error("output probe failed");
      const closeOutput = vi.fn<() => Promise<void>>();
      const openFile = fs.open;
      let interceptedOutput = false;
      const openSpy = vi.spyOn(fs, "open").mockImplementation(async (pathname, ...args) => {
        const handle = await openFile(pathname, ...args);
        if (!interceptedOutput && path.basename(String(pathname)) === "output.mp4") {
          interceptedOutput = true;
          const close = handle.close.bind(handle);
          closeOutput.mockImplementation(async () => {
            await close();
            throw closeError;
          });
          vi.spyOn(handle, "close").mockImplementation(closeOutput);
        }
        return handle;
      });
      if (probeFails) {
        probePlaybackMediaFileDescriptor
          .mockResolvedValueOnce({ durationMs: 1000, videoCodec: "hevc", videoStreamIndex: 0 })
          .mockRejectedValueOnce(probeError);
      }
      runFfmpeg.mockImplementationOnce(async (args: string[]) => {
        await fs.writeFile(args.at(-1) ?? "", "normalized-video");
        return "";
      });
      const params = { ...source, mimeType: "video/x-matroska", kind: "video" as const };
      try {
        await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
          kind: "preparing",
        });
        const completed = waitForPlaybackSourceCleanup();
        if (probeFails) {
          await completed;
          await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
            kind: "fallback",
          });
          expect(playbackWarn).toHaveBeenCalledWith(expect.stringContaining("output probe failed"));
        } else {
          await completed;
          const result = await playback.resolvePlaybackTranscode(params);
          expect(result.kind).toBe("transcoded");
          if (result.kind !== "transcoded") {
            throw new Error("Expected cached playback output");
          }
          expect(await fs.readFile(result.path, "utf8")).toBe("normalized-video");
        }
        expect(closeOutput).toHaveBeenCalledOnce();
        expect(playbackWarn).toHaveBeenCalledWith("Failed to close playback probe output", {
          error: closeError,
        });
      } finally {
        await waitForPlaybackSourceCleanup();
        openSpy.mockRestore();
      }
    },
  );

  it("retries failed ffmpeg jobs after the bounded cooldown", async () => {
    const source = await createSource("failed.caf", "caff-source");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      runFfmpeg.mockRejectedValueOnce(new Error("ffmpeg unavailable"));
      const params = {
        ...source,
        mimeType: "audio/x-caf",
        kind: "audio" as const,
      };

      await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
        kind: "preparing",
      });
      await waitForPlaybackSourceCleanup();
      expect(runFfmpeg).toHaveBeenCalledOnce();
      await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
        kind: "fallback",
      });
      nowSpy.mockReturnValue(61_001);
      runFfmpeg.mockImplementationOnce(async (args: string[]) => {
        await fs.writeFile(args.at(-1) ?? "", "normalized-audio");
        return "";
      });
      await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
        kind: "preparing",
      });
      await waitForPlaybackSourceCleanup();
      expect(runFfmpeg).toHaveBeenCalledTimes(2);
      await expect(playback.resolvePlaybackTranscode(params)).resolves.toMatchObject({
        kind: "transcoded",
      });
    } finally {
      await waitForPlaybackSourceCleanup();
      nowSpy.mockRestore();
    }
  });

  it.each([
    {
      kind: "audio",
      fileName: "clock-rollback.caf",
      mimeType: "audio/x-caf",
      phase: "before resolution",
      duringCheck: false,
    },
    {
      kind: "video",
      fileName: "clock-rollback-during-check.webm",
      mimeType: "video/webm",
      phase: "during cooldown check",
      duringCheck: true,
    },
  ] as const)(
    "retries failed $kind transcodes when the wall clock moves backward $phase",
    async (media) => {
      const source = await createSource(media.fileName);
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(120_000);
      const params = { ...source, mimeType: media.mimeType, kind: media.kind };

      try {
        runFfmpeg.mockRejectedValueOnce(new Error("ffmpeg temporarily unavailable"));
        await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
          kind: "preparing",
        });
        await waitForPlaybackSourceCleanup();
        expect(runFfmpeg).toHaveBeenCalledOnce();
        await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
          kind: "fallback",
        });

        nowSpy.mockReturnValue(1_000);
        if (media.duringCheck) {
          nowSpy.mockReturnValueOnce(180_001);
        }
        runFfmpeg.mockImplementationOnce(async (args: string[]) => {
          await fs.writeFile(args.at(-1) ?? "", `normalized-${media.kind}`);
          return "";
        });

        await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
          kind: "preparing",
        });
        await waitForPlaybackSourceCleanup();
        expect(runFfmpeg).toHaveBeenCalledTimes(2);
        await expect(playback.resolvePlaybackTranscode(params)).resolves.toMatchObject({
          kind: "transcoded",
        });
      } finally {
        await waitForPlaybackSourceCleanup();
        nowSpy.mockRestore();
      }
    },
  );

  it("warns once when the same transcode operation fails across cooldown retries", async () => {
    const source = await createSource("warn-failed.caf", "caff-source");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1000);
    runFfmpeg.mockRejectedValue(new Error("ffmpeg unavailable"));
    const params = {
      ...source,
      mimeType: "audio/x-caf",
      kind: "audio" as const,
    };

    try {
      await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
        kind: "preparing",
      });
      await waitForPlaybackSourceCleanup();
      await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
        kind: "fallback",
      });
      expect(playbackWarn).toHaveBeenCalledOnce();
      expect(playbackWarn).toHaveBeenCalledWith(
        expect.stringContaining(`${source.sourcePath}: ffmpeg unavailable`),
      );

      nowSpy.mockReturnValue(61_001);
      await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
        kind: "preparing",
      });
      await waitForPlaybackSourceCleanup();
      expect(runFfmpeg).toHaveBeenCalledTimes(2);
      await expect(playback.resolvePlaybackTranscode(params)).resolves.toEqual({
        kind: "fallback",
      });
      expect(playbackWarn).toHaveBeenCalledOnce();
    } finally {
      await waitForPlaybackSourceCleanup();
      nowSpy.mockRestore();
    }
  });

  it("keeps a saturated transcode pool retryable until capacity is available", async () => {
    const sources = await Promise.all([
      createSource("pool-first.mkv"),
      createSource("pool-second.mkv"),
      createSource("pool-third.mkv"),
    ]);
    const transcodes = sources.map(() => createGatedFfmpegJob("normalized-video"));
    let nextJobIndex = 0;
    runFfmpeg.mockImplementation((args: string[]) => transcodes[nextJobIndex++]!.run(args));
    const params = sources.map(({ sourcePath, sourceStat }) => ({
      sourcePath,
      sourceStat,
      mimeType: "video/x-matroska",
      kind: "video" as const,
    }));

    try {
      await expect(playback.resolvePlaybackTranscode(params[0]!)).resolves.toEqual({
        kind: "preparing",
      });
      await expect(playback.resolvePlaybackTranscode(params[1]!)).resolves.toEqual({
        kind: "preparing",
      });
      await Promise.all(transcodes.slice(0, 2).map((transcode) => transcode.started));
      expect(runFfmpeg).toHaveBeenCalledTimes(2);
      await expect(playback.resolvePlaybackTranscode(params[2]!)).resolves.toEqual({
        kind: "preparing",
      });
      expect(runFfmpeg).toHaveBeenCalledTimes(2);

      const capacityAvailable = waitForPlaybackSourceCleanup("next");
      transcodes[0]!.release();
      await capacityAvailable;
      await expect(playback.resolvePlaybackTranscode(params[2]!)).resolves.toEqual({
        kind: "preparing",
      });
      await transcodes[2]!.started;
      expect(runFfmpeg).toHaveBeenCalledTimes(3);
      const remainingJobs = waitForPlaybackSourceCleanup();
      for (const transcode of transcodes.slice(1)) {
        transcode.release();
      }
      await remainingJobs;
      await expect(
        Promise.all(params.map(async (param) => await playback.resolvePlaybackTranscode(param))),
      ).resolves.toEqual([
        expect.objectContaining({ kind: "transcoded" }),
        expect.objectContaining({ kind: "transcoded" }),
        expect.objectContaining({ kind: "transcoded" }),
      ]);
    } finally {
      for (const transcode of transcodes) {
        transcode.release();
      }
      await waitForPlaybackSourceCleanup();
    }
  });

  it("passes already portable media through without invoking ffmpeg", async () => {
    const source = await createSource("native.mp3", "ID3-native");
    probePlaybackMediaFileDescriptor.mockResolvedValueOnce({
      durationMs: 1000,
      audioCodec: "mp3",
      audioStreamIndex: 0,
    });

    await expect(
      playback.resolvePlaybackTranscode({
        ...source,
        mimeType: "audio/mpeg",
        kind: "audio",
      }),
    ).resolves.toEqual({ kind: "passthrough" });
    expect(runFfmpeg).not.toHaveBeenCalled();
  });

  it("falls back without invoking ffmpeg for media outside the closed demuxer table", async () => {
    const source = await createSource("playlist.m3u8", "https://internal.example/media.ts");

    await expect(
      playback.resolvePlaybackTranscode({
        ...source,
        mimeType: "audio/x-mpegurl",
        kind: "audio",
      }),
    ).resolves.toEqual({ kind: "fallback" });
    expect(runFfmpeg).not.toHaveBeenCalled();
  });
});
