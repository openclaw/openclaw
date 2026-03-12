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

function isMissingBinaryError(err: unknown, binary: string): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const anyErr = err as { code?: unknown; path?: unknown; message?: unknown };
  const code = typeof anyErr.code === "string" ? anyErr.code : "";
  const errPath = typeof anyErr.path === "string" ? anyErr.path : "";
  const message = typeof anyErr.message === "string" ? anyErr.message : "";
  if (code !== "ENOENT") {
    return false;
  }
  return errPath === binary || message.includes(binary);
}

function missingBinaryMessage(binary: string): string {
  return (
    `Required media binary "${binary}" was not found in PATH (ENOENT). ` +
    `Install FFmpeg (includes ${binary}) and try again. ` +
    `macOS: \`brew install ffmpeg\`. Ubuntu/Debian: \`sudo apt-get install ffmpeg\`.`
  );
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
    if (isMissingBinaryError(err, "ffprobe")) {
      throw new Error(missingBinaryMessage("ffprobe"), { cause: err });
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
    if (isMissingBinaryError(err, "ffmpeg")) {
      throw new Error(missingBinaryMessage("ffmpeg"), { cause: err });
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
