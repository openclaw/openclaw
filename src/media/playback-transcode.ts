// Playback transcode policy and lazy media-store cache ownership.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sameFileIdentity } from "@openclaw/fs-safe/advanced";
import { fileStore } from "@openclaw/fs-safe/store";
import { withTempWorkspace } from "@openclaw/fs-safe/temp";
import { maxBytesForKind } from "@openclaw/media-core/constants";
import { extensionForMime, normalizeMimeType } from "@openclaw/media-core/mime";
import { createAbortError, racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { hasErrnoCode } from "../infra/errno.js";
import { formatErrorMessage } from "../infra/errors.js";
import { copyFileHandle } from "../infra/file-descriptor.js";
import { openLocalFileSafely } from "../infra/fs-safe.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createPermitPool } from "../shared/permit-pool.js";
import { runFfmpeg } from "./ffmpeg-exec.js";
import {
  probePlaybackMediaFileDescriptor,
  toMediaProbeResult,
  type MediaProbeResult,
  type PlaybackMediaProbeResult,
} from "./media-probe.js";
import {
  PLAYBACK_TRANSCODE_POLICY,
  resolveNativePlaybackCodecCompatibility,
  resolvePlaybackInputFormat,
  resolvePlaybackMode,
  type PlaybackMediaKind,
  type PlaybackMode,
  type PlaybackPolicyEntry,
} from "./playback-codec-policy.js";
import { getMediaDir, PLAYBACK_TRANSCODE_SUBDIR, writePlaybackTranscodeCache } from "./store.js";

type PlaybackSourceIdentity = {
  path: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
};

type PlaybackSourceStat = Omit<PlaybackSourceIdentity, "path">;

type PlaybackInspectionWaiter = { signal?: AbortSignal; assertCurrent?: () => void };

type PlaybackSourceParams = PlaybackInspectionWaiter & {
  sourcePath: string;
  sourceStat: PlaybackSourceStat;
  mimeType: string;
  kind: PlaybackMediaKind;
  admission?: "wait" | "immediate";
};

type PlaybackTranscodeResolution =
  | { kind: "passthrough" }
  | { kind: "preparing" }
  | { kind: "fallback" }
  | {
      kind: "transcoded";
      path: string;
      contentType: string;
      extension: `.${string}`;
    };

type PlaybackInspection = MediaProbeResult &
  (
    | { mode: "native" }
    | { mode: "fallback" }
    | {
        mode: "transcode";
        durationMs: number;
        audioStreamIndex?: number;
        videoStreamIndex?: number;
      }
  );

type PlaybackInspectionJob = {
  result: Promise<PlaybackInspection>;
  waiters: Set<PlaybackInspectionWaiter>;
  controller: AbortController;
  readonly pending: boolean;
};

export class PlaybackInspectionBusyError extends Error {
  constructor() {
    super("Media inspection is busy. Retry shortly.");
  }
}

const PLAYBACK_TRANSCODE_CACHE_VERSION = "v2";
const MAX_PLAYBACK_TRANSCODE_JOBS = 2;
const PLAYBACK_TRANSCODE_MAX_ALLOC_BYTES = 256 * 1024 * 1024;
const PLAYBACK_TRANSCODE_MAX_DURATION_SECS = 20 * 60;
const PLAYBACK_TRANSCODE_MAX_INPUT_PIXELS = 4096 * 4096;
const PLAYBACK_TRANSCODE_THREADS = 2;
const PLAYBACK_TRANSCODE_FAILURE_COOLDOWN_MS = 60_000;
const MAX_PLAYBACK_ENTRIES = { failures: 32, inspections: 32 } as const;
const MAX_PENDING_PLAYBACK_INSPECTIONS = 32;
const playbackJobs = new Map<string, Promise<void>>();
const playbackFailures = new Map<string, number>();
const playbackInspections = new Map<string, PlaybackInspection>();
const playbackInspectionJobs = new Map<string, PlaybackInspectionJob>();
const playbackInspectionPermits = createPermitPool(2);
const log = createSubsystemLogger("media/playback");

/** Hashes the immutable source identity used by playback cache file names. */
function createPlaybackTranscodeCacheKey(source: PlaybackSourceIdentity): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        source.path,
        source.size,
        source.mtimeMs,
        source.ctimeMs,
        source.dev,
        source.ino,
      ]),
    )
    .digest("hex");
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.playbackTranscodeTestApi")] = {
    createPlaybackTranscodeCacheKey,
    getPlaybackTranscodeJobs: (): Promise<void>[] => [...playbackJobs.values()],
  };
}

function playbackSourceIdentity(params: PlaybackSourceParams): PlaybackSourceIdentity {
  return { path: params.sourcePath, ...params.sourceStat };
}

function playbackSourceIdentityMatches(
  source: PlaybackSourceIdentity,
  opened: { realPath: string; stat: PlaybackSourceStat },
): boolean {
  return (
    opened.realPath === source.path &&
    opened.stat.size === source.size &&
    opened.stat.mtimeMs === source.mtimeMs &&
    opened.stat.ctimeMs === source.ctimeMs &&
    opened.stat.dev === source.dev &&
    opened.stat.ino === source.ino
  );
}

function readPlaybackInspection(cacheKey: string): PlaybackInspection | undefined {
  const inspection = playbackInspections.get(cacheKey);
  if (inspection) {
    cachePlaybackInspection(cacheKey, inspection);
  }
  return inspection;
}

function cachePlaybackInspection(cacheKey: string, inspection: PlaybackInspection): void {
  playbackInspections.delete(cacheKey);
  playbackInspections.set(cacheKey, inspection);
  pruneMapToMaxSize(playbackInspections, MAX_PLAYBACK_ENTRIES.inspections);
}

function playbackInspectionCacheKey(params: {
  sourceCacheKey: string;
  kind: PlaybackMediaKind;
  mimeType: string;
}): string {
  return `${params.sourceCacheKey}:${params.kind}:${normalizeMimeType(params.mimeType) ?? "unknown"}`;
}

async function probePlaybackSource(
  source: PlaybackSourceIdentity,
  kind: PlaybackMediaKind,
  assertCurrent: () => void,
): Promise<PlaybackMediaProbeResult | null> {
  assertCurrent();
  await using opened = await openLocalFileSafely({ filePath: source.path }).catch(() => null);
  if (!opened || !playbackSourceIdentityMatches(source, opened)) {
    return null;
  }
  assertCurrent();
  return await probePlaybackMediaFileDescriptor(opened.handle.fd, kind);
}

function assertPlaybackInspectionAuthority(waiters: Set<PlaybackInspectionWaiter>): void {
  let failure: unknown = createAbortError("Playback inspection abandoned");
  for (const waiter of waiters) {
    if (waiter.signal?.aborted) {
      continue;
    }
    try {
      waiter.assertCurrent?.();
      return;
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

async function inspectPlaybackSource(params: PlaybackSourceParams): Promise<PlaybackInspection> {
  params.signal?.throwIfAborted();
  params.assertCurrent?.();
  const policy: PlaybackPolicyEntry = PLAYBACK_TRANSCODE_POLICY[params.kind];
  const containerMode = resolvePlaybackMode(params.mimeType, policy);
  const source = playbackSourceIdentity(params);
  const sourceCacheKey = createPlaybackTranscodeCacheKey(source);
  const cacheKey = playbackInspectionCacheKey({
    sourceCacheKey,
    kind: params.kind,
    mimeType: params.mimeType,
  });
  const cached = readPlaybackInspection(cacheKey);
  if (cached) {
    return cached;
  }
  const computeInspection = async (assertCurrent: () => void): Promise<PlaybackInspection> => {
    const probe = await probePlaybackSource(source, params.kind, assertCurrent);
    const metadata = toMediaProbeResult(probe);
    const mimeType = normalizeMimeType(params.mimeType);
    const needsCodecProbe = Boolean(mimeType && policy.codecProbeInputFormats[mimeType]);
    if (containerMode === "native") {
      const nativeCodecs = !needsCodecProbe
        ? true
        : probe
          ? resolveNativePlaybackCodecCompatibility(params.kind, params.mimeType, probe)
          : undefined;
      if (nativeCodecs !== false) {
        const inspection = { ...metadata, mode: "native" } as const;
        if (probe && nativeCodecs === true) {
          cachePlaybackInspection(cacheKey, inspection);
        }
        return inspection;
      }
    }

    if (!containerMode || source.size > maxBytesForKind(params.kind)) {
      const inspection = { ...metadata, mode: "fallback" } as const;
      if (probe) {
        cachePlaybackInspection(cacheKey, inspection);
      }
      return inspection;
    }

    const maxDurationMs = PLAYBACK_TRANSCODE_MAX_DURATION_SECS * 1000;
    const primaryStreamIndex =
      params.kind === "audio" ? probe?.audioStreamIndex : probe?.videoStreamIndex;
    if (!probe?.durationMs || primaryStreamIndex === undefined) {
      return { ...metadata, mode: "fallback" };
    }
    const inspection: PlaybackInspection =
      probe.durationMs <= maxDurationMs
        ? {
            ...metadata,
            mode: "transcode",
            durationMs: probe.durationMs,
            ...(probe.audioStreamIndex !== undefined
              ? { audioStreamIndex: probe.audioStreamIndex }
              : {}),
            ...(probe.videoStreamIndex !== undefined
              ? { videoStreamIndex: probe.videoStreamIndex }
              : {}),
          }
        : { ...metadata, mode: "fallback" };
    cachePlaybackInspection(cacheKey, inspection);
    return inspection;
  };
  let job = playbackInspectionJobs.get(cacheKey);
  if (job?.pending && params.admission === "immediate") {
    throw new PlaybackInspectionBusyError();
  }
  if (!job) {
    if (playbackInspectionPermits.pendingCount >= MAX_PENDING_PLAYBACK_INSPECTIONS) {
      throw new PlaybackInspectionBusyError();
    }
    const immediatePermit =
      params.admission === "immediate" ? playbackInspectionPermits.tryAcquire() : undefined;
    if (immediatePermit === null) {
      throw new PlaybackInspectionBusyError();
    }
    const waiters = new Set<PlaybackInspectionWaiter>();
    const controller = new AbortController();
    let pending = true;
    const created: PlaybackInspectionJob = {
      waiters,
      controller,
      get pending() {
        return pending;
      },
      result: (async () => {
        const release = await (immediatePermit ??
          playbackInspectionPermits.acquire({ signal: controller.signal }));
        if (!release) {
          throw createAbortError("Playback inspection abandoned");
        }
        pending = false;
        try {
          return await computeInspection(() => assertPlaybackInspectionAuthority(waiters));
        } finally {
          release();
        }
      })().finally(() => {
        // A canceled pending job can be replaced before its promise settles.
        if (playbackInspectionJobs.get(cacheKey) === created) {
          playbackInspectionJobs.delete(cacheKey);
        }
      }),
    };
    job = created;
    playbackInspectionJobs.set(cacheKey, job);
  }
  const waiter = { signal: params.signal, assertCurrent: params.assertCurrent };
  job.waiters.add(waiter);
  try {
    const inspection = await racePromiseWithAbortSignal(job.result, params.signal);
    params.assertCurrent?.();
    return inspection;
  } finally {
    job.waiters.delete(waiter);
    if (job.pending && job.waiters.size === 0) {
      job.controller.abort();
      if (playbackInspectionJobs.get(cacheKey) === job) {
        playbackInspectionJobs.delete(cacheKey);
      }
    }
  }
}

/** Shares display metadata and playback classification by file identity. */
export async function resolvePlaybackMetadataForSource(
  params: PlaybackSourceParams,
): Promise<MediaProbeResult & { playback?: PlaybackMode }> {
  const { mode, durationMs, width, height } = await inspectPlaybackSource(params);
  return { playback: mode === "fallback" ? undefined : mode, durationMs, width, height };
}

/** Replaces the original container suffix for a transcoded response filename. */
export function replacePlaybackFileExtension(fileName: string, extension: `.${string}`): string {
  const currentExtension = path.extname(fileName);
  const stem = currentExtension ? fileName.slice(0, -currentExtension.length) : fileName;
  return `${stem || "media"}${extension}`;
}

function playbackCacheRelativePath(
  cacheKey: string,
  extension: `.${string}`,
): `${typeof PLAYBACK_TRANSCODE_SUBDIR}/${string}` {
  return `${PLAYBACK_TRANSCODE_SUBDIR}/${PLAYBACK_TRANSCODE_CACHE_VERSION}-${cacheKey}${extension}`;
}

async function resolveCachedPlaybackPath(params: {
  cacheKey: string;
  extension: `.${string}`;
  maxBytes: number;
}): Promise<string | null> {
  const store = fileStore({
    rootDir: getMediaDir(),
    dirMode: 0o700,
    mode: 0o600,
    maxBytes: params.maxBytes,
  });
  await using opened = await store
    .open(playbackCacheRelativePath(params.cacheKey, params.extension))
    .catch(() => null);
  return opened?.realPath ?? null;
}

function makePlaybackInputFileName(sourcePath: string, mimeType: string): string {
  const sourceExtension = path.extname(sourcePath).toLowerCase();
  const extension = /^\.[a-z0-9]{1,12}$/u.test(sourceExtension)
    ? sourceExtension
    : (extensionForMime(mimeType) ?? ".media");
  return `input${extension}`;
}

function playbackDurationsMatch(sourceDurationMs: number, outputDurationMs: number): boolean {
  const toleranceMs = Math.min(2000, Math.max(1000, Math.ceil(sourceDurationMs * 0.02)));
  return (
    outputDurationMs <= PLAYBACK_TRANSCODE_MAX_DURATION_SECS * 1000 &&
    Math.abs(outputDurationMs - sourceDurationMs) <= toleranceMs
  );
}

function buildPlaybackFfmpegArgs(params: {
  audioStreamIndex?: number;
  inputPath: string;
  inputFormat: string;
  kind: PlaybackMediaKind;
  maxOutputBytes: number;
  outputPath: string;
  videoStreamIndex?: number;
}): string[] {
  const audioOnly = params.kind === "audio";
  const primaryStreamIndex = audioOnly ? params.audioStreamIndex : params.videoStreamIndex;
  if (primaryStreamIndex === undefined) {
    throw new Error(`Playback ${audioOnly ? "audio" : "video"} stream is missing`);
  }
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-max_alloc",
    String(PLAYBACK_TRANSCODE_MAX_ALLOC_BYTES),
    "-filter_threads",
    String(PLAYBACK_TRANSCODE_THREADS),
    "-y",
    "-protocol_whitelist",
    "file",
    "-f",
    params.inputFormat,
    "-max_pixels",
    String(PLAYBACK_TRANSCODE_MAX_INPUT_PIXELS),
    "-threads",
    String(PLAYBACK_TRANSCODE_THREADS),
    "-i",
    params.inputPath,
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-map",
    `0:${primaryStreamIndex}`,
    ...(!audioOnly && params.audioStreamIndex !== undefined
      ? ["-map", `0:${params.audioStreamIndex}`]
      : []),
    ...(audioOnly ? ["-vn"] : []),
    "-sn",
    "-dn",
    "-t",
    String(PLAYBACK_TRANSCODE_MAX_DURATION_SECS),
    ...(audioOnly
      ? []
      : [
          "-vf",
          "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
          "-c:v",
          "libx264",
          "-threads",
          String(PLAYBACK_TRANSCODE_THREADS),
          "-pix_fmt",
          "yuv420p",
        ]),
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    "-f",
    audioOnly ? "ipod" : "mp4",
    "-fs",
    String(params.maxOutputBytes + 1),
    params.outputPath,
  ];
}

async function transcodePlaybackSource(params: {
  audioStreamIndex?: number;
  source: PlaybackSourceIdentity;
  mimeType: string;
  kind: PlaybackMediaKind;
  cacheKey: string;
  maxBytes: number;
  sourceDurationMs: number;
  videoStreamIndex?: number;
}): Promise<void> {
  const policy: PlaybackPolicyEntry = PLAYBACK_TRANSCODE_POLICY[params.kind];
  await using opened = await openLocalFileSafely({ filePath: params.source.path });
  if (!playbackSourceIdentityMatches(params.source, opened)) {
    throw new Error("Playback source changed before transcode");
  }
  const outputBuffer = await withTempWorkspace(
    {
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "playback-transcode-",
    },
    async (workspace) => {
      const inputName = makePlaybackInputFileName(params.source.path, params.mimeType);
      const stagingName = `.${inputName}.stage`;
      // Keep private-store admission without its full-payload buffering path.
      await workspace.write(stagingName, "");
      const inputRoot = await workspace.store.root();
      let inputPath: string;
      {
        await using staged = await inputRoot.openWritable(stagingName, {
          writeMode: "update",
          mode: 0o600,
          mkdir: false,
        });
        const inputIdentity = await staged.handle.stat({ bigint: true });
        const copiedBytes = await copyFileHandle(opened.handle, staged.handle, {
          maxBytes: Math.min(params.source.size, params.maxBytes),
        });
        if (
          copiedBytes !== params.source.size ||
          !playbackSourceIdentityMatches(params.source, {
            realPath: opened.realPath,
            stat: await opened.handle.stat(),
          })
        ) {
          throw new Error("Playback source changed during transcode read");
        }
        await staged.handle.sync().catch((error: unknown) => {
          if (!hasErrnoCode(error, "EPERM")) {
            throw error;
          }
        });
        // Keep the writer live so replacement cannot reuse its inode before verification.
        await inputRoot.move(stagingName, inputName);
        await using input = await inputRoot.open(inputName);
        const stat = await input.handle.stat({ bigint: true });
        // The move owns its path checks; bind its result to our completed writer.
        if (
          !sameFileIdentity(inputIdentity, stat) ||
          stat.size !== BigInt(params.source.size) ||
          (process.platform !== "win32" && (stat.mode & 0o7777n) !== 0o600n)
        ) {
          throw new Error("Playback staged input changed before transcode");
        }
        inputPath = input.realPath;
      }
      const outputPath = workspace.path(`output${policy.target.extension}`);
      const inputFormat = resolvePlaybackInputFormat(policy, params.mimeType);
      if (!inputFormat) {
        throw new Error("Playback transcode input format is not allowed");
      }
      await runFfmpeg(
        buildPlaybackFfmpegArgs({
          ...(params.audioStreamIndex !== undefined
            ? { audioStreamIndex: params.audioStreamIndex }
            : {}),
          inputPath,
          inputFormat,
          kind: params.kind,
          maxOutputBytes: params.maxBytes,
          outputPath,
          ...(params.videoStreamIndex !== undefined
            ? { videoStreamIndex: params.videoStreamIndex }
            : {}),
        }),
      );
      const outputStat = await fs.stat(outputPath);
      if (!outputStat.isFile() || outputStat.size === 0 || outputStat.size > params.maxBytes) {
        throw new Error("Playback transcode output exceeds its media limit");
      }
      const outputHandle = await fs.open(outputPath, "r");
      let outputProbe: PlaybackMediaProbeResult | null;
      try {
        outputProbe = await probePlaybackMediaFileDescriptor(outputHandle.fd, params.kind);
      } finally {
        await outputHandle.close().catch(() => {});
      }
      if (
        !outputProbe?.durationMs ||
        !playbackDurationsMatch(params.sourceDurationMs, outputProbe.durationMs)
      ) {
        throw new Error("Playback transcode output duration does not match its source");
      }
      return await fs.readFile(outputPath);
    },
  );

  await writePlaybackTranscodeCache({
    buffer: outputBuffer,
    fileName: path.basename(playbackCacheRelativePath(params.cacheKey, policy.target.extension)),
    maxBytes: params.maxBytes,
    tempPrefix: `.${params.cacheKey}`,
  });
}

/** Resolves a native, pending, cached, or failed playback rendition without blocking on ffmpeg. */
export async function resolvePlaybackTranscode(
  params: PlaybackSourceParams,
): Promise<PlaybackTranscodeResolution> {
  params.signal?.throwIfAborted();
  params.assertCurrent?.();
  const policy: PlaybackPolicyEntry = PLAYBACK_TRANSCODE_POLICY[params.kind];
  const containerMode = resolvePlaybackMode(params.mimeType, policy);
  if (!containerMode) {
    return { kind: "fallback" };
  }
  if (
    containerMode === "native" &&
    !policy.codecProbeInputFormats[normalizeMimeType(params.mimeType) ?? ""]
  ) {
    return { kind: "passthrough" };
  }
  const maxBytes = maxBytesForKind(params.kind);
  const source = playbackSourceIdentity(params);
  const cacheKey = createPlaybackTranscodeCacheKey(source);
  const target = policy.target;
  const operationKey = playbackCacheRelativePath(cacheKey, target.extension);
  const cachedPath = await resolveCachedPlaybackPath({
    cacheKey,
    extension: target.extension,
    maxBytes,
  });
  params.signal?.throwIfAborted();
  params.assertCurrent?.();
  if (cachedPath) {
    return {
      kind: "transcoded",
      path: cachedPath,
      contentType: target.contentType,
      extension: target.extension,
    };
  }

  let inspection: PlaybackInspection;
  try {
    inspection = await inspectPlaybackSource(params);
  } catch (error) {
    if (error instanceof PlaybackInspectionBusyError) {
      return { kind: "preparing" };
    }
    throw error;
  }
  params.signal?.throwIfAborted();
  if (inspection.mode === "native") {
    return { kind: "passthrough" };
  }
  if (inspection.mode === "fallback") {
    return { kind: "fallback" };
  }

  if (playbackJobs.has(operationKey)) {
    return { kind: "preparing" };
  }
  const failedAtMs = playbackFailures.get(operationKey);
  if (failedAtMs !== undefined) {
    const nowMs = Date.now();
    if (failedAtMs <= nowMs && nowMs - failedAtMs < PLAYBACK_TRANSCODE_FAILURE_COOLDOWN_MS) {
      return { kind: "fallback" };
    }
  }
  if (playbackJobs.size >= MAX_PLAYBACK_TRANSCODE_JOBS) {
    return { kind: "preparing" };
  }

  const job = transcodePlaybackSource({
    ...(inspection.audioStreamIndex !== undefined
      ? { audioStreamIndex: inspection.audioStreamIndex }
      : {}),
    source,
    mimeType: params.mimeType,
    kind: params.kind,
    cacheKey,
    maxBytes,
    sourceDurationMs: inspection.durationMs,
    ...(inspection.videoStreamIndex !== undefined
      ? { videoStreamIndex: inspection.videoStreamIndex }
      : {}),
  });
  // Pool admission and test synchronization must observe the same completion boundary.
  playbackJobs.set(operationKey, job);
  void job.then(
    () => {
      playbackJobs.delete(operationKey);
      playbackFailures.delete(operationKey);
    },
    (reason: unknown) => {
      playbackJobs.delete(operationKey);
      if (!playbackFailures.has(operationKey)) {
        log.warn(
          `Playback transcode failed for ${params.sourcePath}: ${formatErrorMessage(reason)}`,
        );
      }
      playbackFailures.delete(operationKey);
      playbackFailures.set(operationKey, Date.now());
      pruneMapToMaxSize(playbackFailures, MAX_PLAYBACK_ENTRIES.failures);
    },
  );
  return { kind: "preparing" };
}
