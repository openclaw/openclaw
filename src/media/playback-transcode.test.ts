import "../test-utils/prepare-compiled-subprocesses.js";
import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { PlaybackMediaProbeResult } from "./media-probe.js";
import {
  observePlaybackSourceOpen,
  readPlaybackSource,
  usePlaybackFixture,
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

const { createSource, resolveTranscode, resolveMetadata } = usePlaybackFixture(
  "openclaw-playback-transcode-",
  ["../infra/fs-safe.js", "./ffmpeg-exec.js", "./media-probe.js"],
);

beforeEach(() => {
  playbackWarn.mockReset();
  runFfmpeg.mockReset();
  probePlaybackMediaFileDescriptor.mockReset();
  probePlaybackMediaFileDescriptor.mockImplementation(async (_fd: number, kind: string) =>
    kind === "audio"
      ? { durationMs: 1000, audioCodec: "pcm_s16le", audioStreamIndex: 0 }
      : videoProbe({
          videoCodec: "vp9",
          audioCodec: "opus",
          audioStreamIndex: 1,
        }),
  );
});

function videoRequest(source: Awaited<ReturnType<typeof createSource>>, mimeType = "video/mp4") {
  return { ...source, mimeType, kind: "video" as const };
}

function videoProbe(probe: PlaybackMediaProbeResult): PlaybackMediaProbeResult {
  return { durationMs: 1000, videoStreamIndex: 0, ...probe };
}

type PlaybackRequest = Parameters<typeof resolveTranscode>[0];

async function expectResolution(
  params: PlaybackRequest,
  kind: "preparing" | "fallback" | "passthrough" | "transcoded",
) {
  const result = await resolveTranscode(params);
  expect(result).toEqual(kind === "transcoded" ? expect.objectContaining({ kind }) : { kind });
}

async function finishJob(job: ReturnType<typeof createGatedFfmpegJob>) {
  const finished = waitForPlaybackSourceCleanup();
  job.release();
  await finished;
}

function writeFfmpegOutput(output: string) {
  return async (args: string[]) => {
    await fs.writeFile(args.at(-1) ?? "", output);
    return "";
  };
}

function createGatedFfmpegJob(output: string) {
  const started = createDeferred();
  const gate = createDeferred();
  return {
    started: started.promise,
    release: gate.resolve,
    async [Symbol.asyncDispose]() {
      gate.resolve();
      await waitForPlaybackSourceCleanup();
    },
    run: async (args: string[]) => {
      started.resolve();
      await gate.promise;
      await fs.writeFile(args.at(-1) ?? "", output);
      return "";
    },
  };
}

describe("resolvePlaybackTranscode", () => {
  it("does not reuse a rendition after the source file is replaced", async () => {
    using sync = vi.spyOn(syncFs, "fsyncSync");
    const original = await createSource("replaced-cache.mkv", "first-source");
    const params = videoRequest(original, "video/x-matroska");
    runFfmpeg.mockImplementation(async (args: string[]) => {
      await fs.writeFile(args.at(-1) ?? "", `rendition-${runFfmpeg.mock.calls.length}`);
      return "";
    });
    await expectResolution(params, "preparing");
    await waitForPlaybackSourceCleanup();
    await expectResolution(params, "transcoded");

    await fs.rename(original.sourcePath, `${original.sourcePath}.old`);
    const replacement = await createSource("replaced-cache.mkv", "other-source");
    expect(replacement.sourceStat.exactIdentity.ino).not.toBe(
      original.sourceStat.exactIdentity.ino,
    );
    const replacedParams = { ...params, ...replacement };
    await expectResolution(replacedParams, "preparing");
    await waitForPlaybackSourceCleanup();
    const result = await resolveTranscode(replacedParams);
    expect(runFfmpeg).toHaveBeenCalledTimes(2);
    if (result.kind !== "transcoded") {
      throw new Error("Expected replacement playback output");
    }
    expect(await fs.readFile(result.path, "utf8")).toBe("rendition-2");
    expect(sync).not.toHaveBeenCalled();
  });
  it("falls back before ffmpeg when source duration exceeds the transcode limit", async () => {
    const source = await createSource("long-video.mkv");
    probePlaybackMediaFileDescriptor.mockResolvedValueOnce({
      durationMs: 20 * 60 * 1000 + 1,
      videoCodec: "hevc",
      videoStreamIndex: 0,
    });

    await expectResolution(videoRequest(source, "video/x-matroska"), "fallback");
    expect(runFfmpeg).not.toHaveBeenCalled();
  });

  it("scopes cached codec classification by media kind and MIME", async () => {
    const source = await createSource("dual-track.mp4");
    probePlaybackMediaFileDescriptor
      .mockResolvedValueOnce({ durationMs: 1000, audioCodec: "aac", audioStreamIndex: 1 })
      .mockResolvedValueOnce(
        videoProbe({
          videoCodec: "hevc",
          audioCodec: "aac",
          audioStreamIndex: 1,
        }),
      );

    await expect(
      resolveMetadata({
        ...source,
        mimeType: "audio/mp4",
        kind: "audio",
      }),
    ).resolves.toMatchObject({ playback: "native" });
    await expect(resolveMetadata(videoRequest(source))).resolves.toMatchObject({
      playback: "transcode",
    });
  });

  it.each([
    ["hevc", undefined],
    ["h264", "native"],
  ] as const)("only advertises native playback for oversized %s media", async (codec, expected) => {
    const source = await createSource(`oversized-${codec}.mp4`);
    await fs.truncate(source.sourcePath, 16 * 1024 * 1024 + 1);
    probePlaybackMediaFileDescriptor.mockResolvedValueOnce(
      videoProbe({
        videoCodec: codec,
        videoProfile: "high",
        videoPixelFormat: "yuv420p",
      }),
    );

    const metadata = await resolveMetadata(
      videoRequest(await readPlaybackSource(source.sourcePath)),
    );
    expect(metadata.playback).toBe(expected);
  });

  it.each([
    ["high-10", { videoProfile: "high 10", videoPixelFormat: "yuv420p10le" }],
    ["unknown-profile-opus", { audioCodec: "opus", audioStreamIndex: 1 }],
  ] as const)("transcodes incompatible H.264 media: %s", async (name, probe) => {
    const source = await createSource(`${name}.mp4`);
    probePlaybackMediaFileDescriptor.mockResolvedValueOnce(
      videoProbe({ videoCodec: "h264", ...probe }),
    );
    await expect(resolveMetadata(videoRequest(source))).resolves.toMatchObject({
      playback: "transcode",
    });
  });

  it("does not cache native when a selected audio stream has an unknown codec", async () => {
    const source = await createSource("unknown-audio.mp4");
    const probe = videoProbe({
      videoCodec: "h264",
      videoProfile: "high",
      videoPixelFormat: "yuv420p",
      audioStreamIndex: 1,
    });
    probePlaybackMediaFileDescriptor
      .mockResolvedValueOnce(probe)
      .mockResolvedValueOnce({ ...probe, audioCodec: "opus" });

    await expect(resolveMetadata(videoRequest(source))).resolves.toMatchObject({
      playback: "native",
    });
    await expect(resolveMetadata(videoRequest(source))).resolves.toMatchObject({
      playback: "transcode",
    });
  });

  it.each([
    ["mp4", "video/mp4", "passthrough"],
    ["mkv", "video/x-matroska", "fallback"],
  ] as const)("retries inconclusive %s inspection", async (extension, mimeType, initial) => {
    const source = await createSource(`probe-retry.${extension}`);
    await using transcode = createGatedFfmpegJob("normalized-video");
    probePlaybackMediaFileDescriptor
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        videoProbe({ videoCodec: "hevc", audioCodec: "aac", audioStreamIndex: 1 }),
      );
    runFfmpeg.mockImplementationOnce(transcode.run);
    const params = videoRequest(source, mimeType);
    await expectResolution(params, initial);
    await expectResolution(params, "preparing");
    await transcode.started;
    expect(runFfmpeg).toHaveBeenCalledOnce();
    expect(probePlaybackMediaFileDescriptor).toHaveBeenCalledTimes(2);
    await finishJob(transcode);
    await expectResolution(params, "transcoded");
  });

  it("shares concurrent inspections and reuses display metadata for a warm source", async () => {
    const source = await createSource("inspection-single-flight.mp4");
    const probeStarted = createDeferred();
    const probeGate = createDeferred<PlaybackMediaProbeResult>();
    probePlaybackMediaFileDescriptor.mockImplementationOnce(async () => {
      probeStarted.resolve();
      return await probeGate.promise;
    });
    const params = videoRequest(source);

    const nativeProbe: PlaybackMediaProbeResult = videoProbe({
      width: 720,
      height: 480,
      videoRotation: 90,
      videoSampleAspectRatio: 4 / 3,
      videoCodec: "h264",
      videoProfile: "high",
      videoPixelFormat: "yuv420p",
      audioCodec: "aac",
      audioStreamIndex: 1,
    });
    const first = resolveMetadata(params);
    const second = resolveMetadata(params);
    try {
      await probeStarted.promise;
      expect(probePlaybackMediaFileDescriptor).toHaveBeenCalledOnce();
      probeGate.resolve(nativeProbe);
      const metadata = { playback: "native", durationMs: 1000, width: 480, height: 960 };
      await expect(Promise.all([first, second])).resolves.toEqual([metadata, metadata]);
      await expect(resolveMetadata(params)).resolves.toEqual(metadata);
      expect(probePlaybackMediaFileDescriptor).toHaveBeenCalledOnce();
    } finally {
      probeGate.resolve(nativeProbe);
      await Promise.allSettled([first, second]);
    }
  });

  it("single-flights MIME aliases that target the same cached rendition", async () => {
    const source = await createSource("alias-audio.mp4");
    await using transcode = createGatedFfmpegJob("normalized-audio");
    probePlaybackMediaFileDescriptor.mockResolvedValue({
      durationMs: 1000,
      audioCodec: "opus",
      audioStreamIndex: 0,
    });
    runFfmpeg.mockImplementationOnce(transcode.run);
    const base = { ...source, kind: "audio" as const };

    await expect(
      Promise.all([
        resolveTranscode({ ...base, mimeType: "audio/mp4" }),
        resolveTranscode({ ...base, mimeType: "audio/x-m4a" }),
      ]),
    ).resolves.toEqual([{ kind: "preparing" }, { kind: "preparing" }]);
    await transcode.started;
    expect(runFfmpeg).toHaveBeenCalledOnce();
    await finishJob(transcode);
    await expect(resolveTranscode({ ...base, mimeType: "audio/mp4" })).resolves.toMatchObject({
      kind: "transcoded",
      contentType: "audio/mp4",
      extension: ".m4a",
    });
  });

  it.each([
    ["mkv", "video/x-matroska", "matroska,webm", 0, 1],
    ["mp4", "video/mp4", "mov", 2, 3],
  ] as const)(
    "single-flights %s conversion and reuses its store entry",
    async (extension, mimeType, format, videoIndex, audioIndex) => {
      const source = await createSource(`single-flight.${extension}`);
      if (extension === "mp4") {
        probePlaybackMediaFileDescriptor.mockResolvedValueOnce(
          videoProbe({
            videoCodec: "hevc",
            videoStreamIndex: videoIndex,
            audioCodec: "aac",
            audioStreamIndex: audioIndex,
          }),
        );
      }
      await using transcode = createGatedFfmpegJob("normalized-video");
      runFfmpeg.mockImplementation(transcode.run);

      const params = videoRequest(source, mimeType);
      await expectResolution(params, "preparing");
      await expectResolution(params, "preparing");
      await transcode.started;
      expect(runFfmpeg).toHaveBeenCalledOnce();
      expect(probePlaybackMediaFileDescriptor).toHaveBeenCalledOnce();
      await finishJob(transcode);

      const resolved = await resolveTranscode(params);
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
        expect.arrayContaining(
          [
            ["-max_alloc", String(256 * 1024 * 1024)],
            ["-filter_threads", "2"],
            ["-protocol_whitelist", "file"],
            ["-f", format],
            ["-max_pixels", String(4096 * 4096)],
            ["-threads", "2"],
            ["-map", `0:${videoIndex}`, "-map", `0:${audioIndex}`],
            ["-t", String(20 * 60)],
            ["-c:v", "libx264", "-c:a", "aac"],
            ["-movflags", "+faststart"],
            ["-fs", String(16 * 1024 * 1024 + 1)],
          ].flat(),
        ),
      );
    },
  );

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
          .mockResolvedValueOnce(
            videoProbe({
              videoCodec: "hevc",
            }),
          )
          .mockRejectedValueOnce(probeError);
      }
      runFfmpeg.mockImplementationOnce(writeFfmpegOutput("normalized-video"));
      const params = videoRequest(source, "video/x-matroska");
      try {
        await expectResolution(params, "preparing");
        const completed = waitForPlaybackSourceCleanup();
        if (probeFails) {
          await completed;
          await expectResolution(params, "fallback");
          expect(playbackWarn).toHaveBeenCalledWith(expect.stringContaining("output probe failed"));
        } else {
          await completed;
          const result = await resolveTranscode(params);
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

  it.each([
    ["audio", "cooldown.caf", "audio/x-caf", "elapsed"],
    ["audio", "cooldown.mp3", "audio/mpeg", "elapsed"],
    ["audio", "warn-failed.caf", "audio/x-caf", "failure-again"],
    ["audio", "clock-rollback.caf", "audio/x-caf", "rollback"],
    ["video", "clock-rollback-during-check.webm", "video/webm", "during-check"],
  ] as const)(
    "retries failed %s transcodes (%s, %s, clock: %s)",
    async (kind, fileName, mimeType, clock) => {
      const source = await createSource(fileName);
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(120_000);
      const params = { ...source, mimeType, kind };

      try {
        runFfmpeg.mockRejectedValueOnce(new Error("ffmpeg unavailable"));
        await expectResolution(params, "preparing");
        await waitForPlaybackSourceCleanup();
        expect(runFfmpeg).toHaveBeenCalledOnce();
        await expectResolution(params, "fallback");
        expect(playbackWarn).toHaveBeenCalledOnce();
        expect(playbackWarn).toHaveBeenCalledWith(
          expect.stringContaining(`${source.sourcePath}: ffmpeg unavailable`),
        );

        nowSpy.mockReturnValue(clock === "elapsed" || clock === "failure-again" ? 180_001 : 1_000);
        if (clock === "during-check") {
          nowSpy.mockReturnValueOnce(180_001);
        }
        if (clock === "failure-again") {
          runFfmpeg.mockRejectedValueOnce(new Error("ffmpeg unavailable"));
        } else {
          runFfmpeg.mockImplementationOnce(writeFfmpegOutput(`normalized-${kind}`));
        }

        await expectResolution(params, "preparing");
        await waitForPlaybackSourceCleanup();
        expect(runFfmpeg).toHaveBeenCalledTimes(2);
        if (clock === "failure-again") {
          await expectResolution(params, "fallback");
        } else {
          await expect(resolveTranscode(params)).resolves.toMatchObject(
            kind === "audio"
              ? { kind: "transcoded", contentType: "audio/mp4", extension: ".m4a" }
              : { kind: "transcoded", contentType: "video/mp4", extension: ".mp4" },
          );
        }
        expect(playbackWarn).toHaveBeenCalledOnce();
      } finally {
        await waitForPlaybackSourceCleanup();
        nowSpy.mockRestore();
      }
    },
  );

  it("keeps a saturated transcode pool retryable until capacity is available", async () => {
    const sources = await Promise.all([
      createSource("pool-first.mkv"),
      createSource("pool-second.mkv"),
      createSource("pool-third.mkv"),
    ]);
    const transcodes = sources.map(() => createGatedFfmpegJob("normalized-video"));
    let nextJobIndex = 0;
    runFfmpeg.mockImplementation((args: string[]) => transcodes[nextJobIndex++]!.run(args));
    const params = sources.map((source) => videoRequest(source, "video/x-matroska"));

    try {
      await expectResolution(params[0]!, "preparing");
      await expectResolution(params[1]!, "preparing");
      await Promise.all(transcodes.slice(0, 2).map((transcode) => transcode.started));
      expect(runFfmpeg).toHaveBeenCalledTimes(2);
      await expectResolution(params[2]!, "preparing");
      expect(runFfmpeg).toHaveBeenCalledTimes(2);

      const capacityAvailable = waitForPlaybackSourceCleanup("next");
      transcodes[0]!.release();
      await capacityAvailable;
      await expectResolution(params[2]!, "preparing");
      await transcodes[2]!.started;
      expect(runFfmpeg).toHaveBeenCalledTimes(3);
      const remainingJobs = waitForPlaybackSourceCleanup();
      for (const transcode of transcodes.slice(1)) {
        transcode.release();
      }
      await remainingJobs;
      await expect(
        Promise.all(params.map(async (param) => await resolveTranscode(param))),
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

  it.each([
    ["audio/mpeg", "mp3", "passthrough"],
    ["audio/mp3", "mp3", "passthrough"],
    ["audio/wav", "pcm_s16le", "passthrough"],
    ["audio/x-mpegurl", undefined, "fallback"],
  ] as const)("resolves %s without ffmpeg", async (mimeType, codec, expected) => {
    const source = await createSource(`no-ffmpeg-${mimeType.replaceAll("/", "-")}`);
    if (codec) {
      probePlaybackMediaFileDescriptor.mockResolvedValueOnce({
        durationMs: 1000,
        audioCodec: codec,
        audioStreamIndex: 0,
      });
    }
    const params = { ...source, mimeType, kind: "audio" as const };
    await expectResolution(params, expected);
    if (codec) {
      expect((await resolveMetadata(params)).playback).toBe("native");
    }
    expect(runFfmpeg).not.toHaveBeenCalled();
  });
});
