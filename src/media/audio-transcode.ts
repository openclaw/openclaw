import path from "node:path";
import { tempWorkspace, withTempWorkspace } from "@openclaw/fs-safe/temp";
import { basenameFromAnyPath } from "@openclaw/media-core/file-name";
import { writeExternalFileWithinRoot } from "../infra/fs-safe.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { logWarn } from "../logger.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { runFfmpeg } from "./ffmpeg-exec.js";

let warnedMp3CafFallback = false;
const CAF_OPUS_SAMPLE_RATE_HZ = 24_000;
const DEFAULT_OPUS_SAMPLE_RATE_HZ = 48_000;
const DEFAULT_OPUS_BITRATE = "64k";
const DEFAULT_OPUS_CHANNELS = 1;
const DEFAULT_TEMP_PREFIX = "audio-opus-";
const DEFAULT_OUTPUT_FILE_NAME = "voice.opus";

function normalizeTempPrefix(value?: string): string {
  const sanitized = value?.trim().replace(/[^a-zA-Z0-9._-]/g, "-");
  if (!sanitized || sanitized === "." || sanitized === "..") {
    return DEFAULT_TEMP_PREFIX;
  }
  return sanitized.endsWith("-") ? sanitized : `${sanitized}-`;
}

function normalizeOutputFileName(value?: string): string {
  const baseName = basenameFromAnyPath(value?.trim() || DEFAULT_OUTPUT_FILE_NAME);
  if (/^[a-zA-Z0-9._-]{1,80}$/.test(baseName) && baseName !== "." && baseName !== "..") {
    return baseName;
  }
  return DEFAULT_OUTPUT_FILE_NAME;
}

/** Transcodes arbitrary audio input into mono Opus using a scoped temp workspace. */
export async function transcodeAudioBufferToOpus(params: {
  audioBuffer: Buffer;
  inputExtension?: string;
  inputFileName?: string;
  tempPrefix?: string;
  outputFileName?: string;
  timeoutMs?: number;
  sampleRateHz?: number;
  bitrate?: string;
  channels?: number;
  /** Maximum output duration passed to ffmpeg's `-t` option. */
  maxDurationSeconds?: number;
}): Promise<Buffer> {
  const maxDurationSeconds = params.maxDurationSeconds;
  if (
    maxDurationSeconds !== undefined &&
    (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0)
  ) {
    throw new Error("maxDurationSeconds must be a positive finite number");
  }
  return await withTempWorkspace(
    {
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: normalizeTempPrefix(params.tempPrefix),
    },
    async (workspace) => {
      const fromExtension = params.inputExtension?.trim();
      const candidate = fromExtension
        ? fromExtension.startsWith(".")
          ? fromExtension
          : `.${fromExtension}`
        : path.extname(params.inputFileName ?? "");
      const normalized = candidate.toLowerCase();
      const inputExtension = /^\.[a-z0-9]{1,12}$/.test(normalized) ? normalized : ".audio";
      const inputPath = await workspace.store.write(`input${inputExtension}`, params.audioBuffer, {
        durable: false,
      });
      const outputFileName = normalizeOutputFileName(params.outputFileName);
      await writeExternalFileWithinRoot({
        rootDir: workspace.dir,
        path: outputFileName,
        write: async (outputPath) => {
          await runFfmpeg(
            [
              "-hide_banner",
              "-loglevel",
              "error",
              "-y",
              "-i",
              inputPath,
              "-vn",
              "-sn",
              "-dn",
              ...(maxDurationSeconds === undefined ? [] : ["-t", String(maxDurationSeconds)]),
              "-c:a",
              "libopus",
              "-b:a",
              params.bitrate ?? DEFAULT_OPUS_BITRATE,
              "-ar",
              String(params.sampleRateHz ?? DEFAULT_OPUS_SAMPLE_RATE_HZ),
              "-ac",
              String(params.channels ?? DEFAULT_OPUS_CHANNELS),
              "-f",
              "opus",
              outputPath,
            ],
            { timeoutMs: params.timeoutMs },
          );
        },
      });
      return await workspace.read(outputFileName);
    },
  );
}

/** Outcome for lightweight container transcodes that may be unsupported or intentionally skipped. */
type AudioContainerTranscodeOutcome =
  | { ok: true; buffer: Buffer }
  | {
      ok: false;
      reason:
        | "platform-unsupported"
        | "invalid-extension"
        | "noop-same-container"
        | "no-recipe"
        | "transcoder-failed";
      detail?: string;
    };

/** Transcodes known audio container pairs, currently using macOS afconvert recipes where needed. */
export async function transcodeAudioBuffer(params: {
  audioBuffer: Buffer;
  sourceExtension: string;
  targetExtension: string;
  timeoutMs?: number;
}): Promise<AudioContainerTranscodeOutcome> {
  const source = normalizeContainerExt(params.sourceExtension);
  const target = normalizeContainerExt(params.targetExtension);
  if (!source || !target) {
    return { ok: false, reason: "invalid-extension" };
  }
  if (source === target) {
    return { ok: false, reason: "noop-same-container" };
  }
  if (target !== "caf") {
    return { ok: false, reason: "no-recipe" };
  }
  if (process.platform !== "darwin") {
    return { ok: false, reason: "platform-unsupported" };
  }

  // afconvert is macOS-only and writes native Messages-compatible voice containers.
  const tmp = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "tts-transcode-",
  });
  try {
    const deadline = performance.now() + (params.timeoutMs ?? 5000);
    const remaining = () => {
      const ms = Math.floor(deadline - performance.now());
      if (!Number.isFinite(ms) || ms <= 0) {
        throw new Error("audio transcode timeout budget exhausted");
      }
      return ms;
    };
    const inPath = await tmp.store.write(`in.${source}`, params.audioBuffer, { durable: false });
    let encoderInput = inPath;
    let expectedFrames: number | undefined;
    if (source === "mp3") {
      // afconvert can silently truncate compressed MP3 input. Decode first, then
      // give Apple's Messages-compatible Opus-in-CAF encoder uncompressed PCM.
      encoderInput = tmp.path("decoded.wav");
      await runFfmpeg(
        [
          "-nostdin",
          "-v",
          "error",
          "-y",
          "-i",
          inPath,
          "-vn",
          "-sn",
          "-dn",
          "-ac",
          "1",
          "-ar",
          String(CAF_OPUS_SAMPLE_RATE_HZ),
          "-c:a",
          "pcm_s16le",
          encoderInput,
        ],
        { timeoutMs: remaining() },
      );
      expectedFrames = readPcmWavFrames(await tmp.read("decoded.wav"));
      if (expectedFrames <= 0) {
        throw new Error("decoded PCM has no frames");
      }
    }
    const outPath = tmp.path(`out.${target}`);
    const failure = await runAfconvert(
      // Opus-in-CAF matches native Messages voice memo attachments.
      ["-f", "caff", "-d", "opus@24000", "-c", "1", encoderInput, outPath],
      remaining(),
    );
    if (failure !== undefined) {
      throw new Error(failure);
    }
    if (expectedFrames !== undefined) {
      const result = await runCommandWithTimeout(["/usr/bin/afinfo", outPath], {
        timeoutMs: remaining(),
        maxOutputBytes: 8192,
        env: { LC_ALL: "C", LANG: "C" },
      });
      const actualFrames = Number(result.stdout.match(/audio (\d+) valid frames/)?.[1]);
      if (
        result.code !== 0 ||
        result.termination === "timeout" ||
        !/Data format:\s+1 ch,\s+24000 Hz/.test(result.stdout) ||
        !Number.isSafeInteger(actualFrames) ||
        actualFrames <= 0 ||
        Math.abs(actualFrames - expectedFrames) > Math.max(2, Math.ceil(expectedFrames * 0.001))
      ) {
        throw new Error("CAF frame validation failed");
      }
    }
    const buffer = await tmp.read(`out.${target}`);
    remaining();
    return { ok: true, buffer };
  } catch (err) {
    if (source === "mp3" && !warnedMp3CafFallback) {
      warnedMp3CafFallback = true;
      logWarn("MP3-to-CAF conversion failed; keeping the original audio attachment.");
    }
    return { ok: false, reason: "transcoder-failed", detail: (err as Error).message };
  } finally {
    await tmp.cleanup();
  }
}

// Parse bounded RIFF chunks rather than platform-dependent afinfo LPCM wording.
function readPcmWavFrames(buffer: Buffer): number {
  const invalid = (): never => {
    throw new Error("invalid decoded PCM WAV header");
  };
  if (
    buffer.length < 12 ||
    buffer.toString("latin1", 0, 4) !== "RIFF" ||
    buffer.toString("latin1", 8, 12) !== "WAVE"
  ) {
    invalid();
  }
  const end = buffer.readUInt32LE(4) + 8;
  if (end !== buffer.length) {
    invalid();
  }
  let fmtSeen = false;
  let dataBytes: number | undefined;
  let offset = 12;
  while (offset < end) {
    if (offset + 8 > end) {
      invalid();
    }
    const id = buffer.toString("latin1", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const next = start + size + (size & 1);
    if (next > end) {
      invalid();
    }
    if (id === "fmt ") {
      if (fmtSeen || size < 16) {
        invalid();
      }
      if (
        buffer.readUInt16LE(start) !== 1 ||
        buffer.readUInt16LE(start + 2) !== 1 ||
        buffer.readUInt32LE(start + 4) !== CAF_OPUS_SAMPLE_RATE_HZ ||
        buffer.readUInt32LE(start + 8) !== CAF_OPUS_SAMPLE_RATE_HZ * 2 ||
        buffer.readUInt16LE(start + 12) !== 2 ||
        buffer.readUInt16LE(start + 14) !== 16
      ) {
        invalid();
      }
      fmtSeen = true;
    } else if (id === "data") {
      if (dataBytes !== void 0 || size % 2 !== 0) {
        invalid();
      }
      dataBytes = size;
    }
    offset = next;
  }
  if (!fmtSeen || dataBytes === void 0) {
    invalid();
  }
  return dataBytes / 2;
}

function normalizeContainerExt(ext: string): string | undefined {
  const trimmed = ext.trim().toLowerCase().replace(/^\./, "");
  return /^[a-z0-9]{1,12}$/.test(trimmed) ? trimmed : undefined;
}

async function runAfconvert(args: string[], timeoutMs: number): Promise<string | undefined> {
  try {
    const result = await runCommandWithTimeout(["/usr/bin/afconvert", ...args], {
      maxOutputBytes: 1024,
      timeoutMs,
    });
    if (result.termination === "timeout") {
      return `timeout-${timeoutMs}ms`;
    }
    return result.code === 0 ? undefined : `exit-${result.code ?? "unknown"}`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
