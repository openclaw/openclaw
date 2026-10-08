import fs from "node:fs/promises";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { writeExternalFileWithinRoot } from "../infra/fs-safe.js";
import { runFfmpeg } from "../media/media-services.js";
import type { MediaUnderstandingCapability } from "./types.js";

export async function resolveCliMediaPath(params: {
  capability: MediaUnderstandingCapability;
  command: string;
  mediaPath: string;
  outputDir: string;
  assertCurrent?: () => void;
}): Promise<string> {
  const commandId = path.parse(params.command).name;
  if (params.capability !== "audio" || commandId !== "whisper-cli") {
    return params.mediaPath;
  }

  const ext = normalizeLowercaseStringOrEmpty(path.extname(params.mediaPath));
  if (ext === ".wav") {
    return params.mediaPath;
  }

  const wavPath = path.join(params.outputDir, `${path.parse(params.mediaPath).name}.wav`);
  await fs.mkdir(params.outputDir, { recursive: true });
  await writeExternalFileWithinRoot({
    rootDir: params.outputDir,
    path: path.basename(wavPath),
    write: async (outputPath) => {
      params.assertCurrent?.();
      await runFfmpeg([
        "-y",
        "-i",
        params.mediaPath,
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-f",
        "wav",
        outputPath,
      ]);
    },
  });
  return wavPath;
}
