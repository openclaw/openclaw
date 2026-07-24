// Video dimension helpers read video dimensions through ffprobe.
import { withTempWorkspace } from "../infra/private-temp-workspace.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { runFfprobe } from "./ffmpeg-exec.js";

/** Positive video dimensions reported by ffprobe for the first video stream. */
type VideoDimensions = {
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
function parseFfprobeVideoDimensions(stdout: string): VideoDimensions | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  const streams = (parsed as { streams?: unknown }).streams;
  const stream = Array.isArray(streams) ? streams[0] : undefined;
  if (!stream || typeof stream !== "object") {
    return undefined;
  }
  const record = stream as Record<string, unknown>;
  const width = parsePositiveDimension(record.width);
  const height = parsePositiveDimension(record.height);
  return width && height ? { width, height } : undefined;
}

/**
 * Probes video dimensions via a seekable temp file. Pipe:0 probing fails for
 * large MP4s because ffprobe needs to seek the MOOV atom (often at the end for
 * faststart files), which is impossible over a non-seekable stdin pipe.
 * Temp-file probing resolves dimensions reliably for any buffer size.
 */
export async function probeVideoDimensions(buffer: Buffer): Promise<VideoDimensions | undefined> {
  try {
    return await withTempWorkspace(
      {
        rootDir: resolvePreferredOpenClawTmpDir(),
        prefix: "openclaw-ffprobe-",
      },
      async (workspace) => {
        const tempPath = await workspace.write("video.bin", buffer);
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
      },
    );
  } catch {
    return undefined;
  }
}
