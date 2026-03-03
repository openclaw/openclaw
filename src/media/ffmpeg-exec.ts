import { execFile, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";
import {
  MEDIA_FFMPEG_MAX_BUFFER_BYTES,
  MEDIA_FFMPEG_TIMEOUT_MS,
  MEDIA_FFPROBE_TIMEOUT_MS,
} from "./ffmpeg-limits.js";

const execFileAsync = promisify(execFile);

export type MediaExecOptions = {
  timeoutMs?: number;
  maxBufferBytes?: number;
};

function resolveExecOptions(
  defaultTimeoutMs: number,
  options: MediaExecOptions | undefined,
): ExecFileOptions {
  return {
    timeout: options?.timeoutMs ?? defaultTimeoutMs,
    maxBuffer: options?.maxBufferBytes ?? MEDIA_FFMPEG_MAX_BUFFER_BYTES,
  };
}

export async function runFfprobe(args: string[], options?: MediaExecOptions): Promise<string> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    args,
    resolveExecOptions(MEDIA_FFPROBE_TIMEOUT_MS, options),
  );
  return stdout.toString();
}

export async function runFfmpeg(args: string[], options?: MediaExecOptions): Promise<string> {
  const { stdout } = await execFileAsync(
    "ffmpeg",
    args,
    resolveExecOptions(MEDIA_FFMPEG_TIMEOUT_MS, options),
  );
  return stdout.toString();
}

export function parseFfprobeCsvFields(stdout: string, maxFields: number): string[] {
  return stdout
    .trim()
    .toLowerCase()
    .split(/[,\r\n]+/, maxFields)
    .map((field) => field.trim());
}

export function parseFfprobeCodecAndSampleRate(stdout: string): {
  codec: string | null;
  sampleRateHz: number | null;
} {
  const [codecRaw, sampleRateRaw] = parseFfprobeCsvFields(stdout, 2);
  const codec = codecRaw ? codecRaw : null;
  const sampleRate = sampleRateRaw ? Number.parseInt(sampleRateRaw, 10) : Number.NaN;
  return {
    codec,
    sampleRateHz: Number.isFinite(sampleRate) ? sampleRate : null,
  };
}

/**
 * Parse a duration-seconds string returned by ffprobe (csv=p=0 format).
 * Returns undefined when the string is not a valid non-negative finite number.
 */
export function parseFfprobeDurationSecs(stdout: string): number | undefined {
  const secs = parseFloat(stdout.trim());
  if (!Number.isFinite(secs) || secs < 0) {
    return undefined;
  }
  return secs;
}

/**
 * Get audio duration in milliseconds using ffprobe.
 * Returns undefined if ffprobe is unavailable or parsing fails.
 * Callers should treat undefined as "unknown duration" and omit the field
 * rather than passing 0 (which many APIs interpret as "no audio").
 */
export async function getAudioDurationMs(filePath: string): Promise<number | undefined> {
  try {
    const stdout = await runFfprobe([
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      filePath,
    ]);
    const secs = parseFfprobeDurationSecs(stdout);
    if (secs === undefined) {
      return undefined;
    }
    return Math.round(secs * 1000);
  } catch {
    return undefined;
  }
}
