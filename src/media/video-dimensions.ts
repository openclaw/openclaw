import { execFile } from "node:child_process";

export interface VideoDimensions {
  width: number;
  height: number;
}

/**
 * Probe video dimensions from a Buffer using ffprobe.
 * Returns undefined if ffprobe is unavailable or fails (graceful degradation).
 */
export async function probeVideoDimensions(buffer: Buffer): Promise<VideoDimensions | undefined> {
  try {
    const result = await new Promise<string>((resolve, reject) => {
      const proc = execFile(
        "ffprobe",
        [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=width,height",
          "-of",
          "json",
          "pipe:0",
        ],
        { timeout: 5000 },
        (err, stdout) => {
          if (err) {
            return reject(err);
          }
          resolve(stdout);
        },
      );
      proc.stdin?.end(buffer);
    });

    const parsed = JSON.parse(result);
    const stream = parsed?.streams?.[0];
    if (
      stream &&
      typeof stream.width === "number" &&
      typeof stream.height === "number" &&
      stream.width > 0 &&
      stream.height > 0
    ) {
      return { width: stream.width, height: stream.height };
    }
  } catch {
    // ffprobe not available or failed — fall through gracefully
  }
  return undefined;
}
