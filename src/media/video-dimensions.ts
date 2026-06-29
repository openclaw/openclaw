// Video dimension helpers read video dimensions through ffprobe.
import { randomUUID } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfprobe } from "./ffmpeg-exec.js";

/** Positive video dimensions reported by ffprobe for the first video stream. */
export type VideoDimensions = {
  width: number;
  height: number;
};

function parsePositiveDimension(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

/** Parses ffprobe JSON output, accepting only positive integer first-stream dimensions. */
export function parseFfprobeVideoDimensions(stdout: string): VideoDimensions | undefined {
  const parsed = JSON.parse(stdout) as { streams?: Array<{ width?: unknown; height?: unknown }> };
  const stream = parsed.streams?.[0];
  const width = parsePositiveDimension(stream?.width);
  const height = parsePositiveDimension(stream?.height);
  return width && height ? { width, height } : undefined;
}

/**
 * Probes video dimensions via a seekable temp file. Pipe:0 probing fails for
 * large MP4s because ffprobe needs to seek the MOOV atom (located at the end
 * for faststart files), which is impossible over a non-seekable stdin pipe.
 * Temp-file probing resolves dimensions reliably for any buffer size.
 */
export async function probeVideoDimensions(buffer: Buffer): Promise<VideoDimensions | undefined> {
  const tempPath = join(tmpdir(), `openclaw-ffprobe-${randomUUID()}.bin`);
  let handle;
  try {
    handle = await open(tempPath, "w", 0o600);
    await handle.writeFile(buffer);
    await handle.close();
    handle = undefined;
    const stdout = await runFfprobe([
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      tempPath,
    ]);
    return parseFfprobeVideoDimensions(stdout);
  } catch {
    return undefined;
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    await unlink(tempPath).catch(() => undefined);
  }
}
