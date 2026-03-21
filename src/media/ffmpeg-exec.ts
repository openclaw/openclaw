import { execFile, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";
import {
  MEDIA_FFMPEG_MAX_BUFFER_BYTES,
  MEDIA_FFMPEG_TIMEOUT_MS,
  MEDIA_FFPROBE_TIMEOUT_MS,
} from "./ffmpeg-limits.js";

const execFileAsync = promisify(execFile);

function isEnoent(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
}

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
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      args,
      resolveExecOptions(MEDIA_FFPROBE_TIMEOUT_MS, options),
    );
    return stdout.toString();
  } catch (err) {
    if (isEnoent(err)) {
      throw new Error(
        "Cannot process audio: ffprobe is not installed. Install ffmpeg to enable audio transcription.",
        { cause: err },
      );
    }
    throw err;
  }
}

export async function runFfmpeg(args: string[], options?: MediaExecOptions): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "ffmpeg",
      args,
      resolveExecOptions(MEDIA_FFMPEG_TIMEOUT_MS, options),
    );
    return stdout.toString();
  } catch (err) {
    if (isEnoent(err)) {
      throw new Error(
        "Cannot process audio: ffmpeg is not installed. Install ffmpeg to enable audio transcription.",
        { cause: err },
      );
    }
    throw err;
  }
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
