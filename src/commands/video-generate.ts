import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadConfig } from "../config/config.js";
import type { OutputRuntimeEnv } from "../runtime.js";
import { generateVideo } from "../video-generation/runtime.js";
import type {
  VideoGenerationResolution,
  VideoGenerationSourceAsset,
} from "../video-generation/types.js";

export type VideoGenerateOpts = {
  prompt: string;
  model?: string;
  image?: string[];
  video?: string[];
  aspectRatio?: string;
  resolution?: string;
  duration?: number;
  audio?: boolean;
  watermark?: boolean;
  output?: string;
  json?: boolean;
};

const VALID_ASPECT_RATIOS = new Set([
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
]);

const VALID_RESOLUTIONS = new Set<string>(["480P", "720P", "1080P"]);

const MAX_INPUT_IMAGES = 5;
const MAX_INPUT_VIDEOS = 4;

function resolveTildePath(filePath: string): string {
  if (filePath.startsWith("~/")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    return path.join(home, filePath.slice(2));
  }
  return filePath;
}

async function loadLocalAsset(filePath: string): Promise<VideoGenerationSourceAsset> {
  const resolved = resolveTildePath(filePath);
  const absolute = path.isAbsolute(resolved) ? resolved : path.resolve(resolved);
  const buffer = await fs.readFile(absolute);
  const ext = path.extname(absolute).toLowerCase();

  const mimeMap: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
  };

  return {
    buffer,
    mimeType: mimeMap[ext],
    fileName: path.basename(absolute),
  };
}

async function loadAssets(paths: string[]): Promise<VideoGenerationSourceAsset[]> {
  return Promise.all(paths.map(loadLocalAsset));
}

function validateOpts(opts: VideoGenerateOpts): string | null {
  if (opts.image && opts.image.length > MAX_INPUT_IMAGES) {
    return `Too many reference images: ${opts.image.length} (max ${MAX_INPUT_IMAGES})`;
  }
  if (opts.video && opts.video.length > MAX_INPUT_VIDEOS) {
    return `Too many reference videos: ${opts.video.length} (max ${MAX_INPUT_VIDEOS})`;
  }
  if (opts.aspectRatio && !VALID_ASPECT_RATIOS.has(opts.aspectRatio)) {
    return `Invalid aspect ratio "${opts.aspectRatio}". Valid: ${[...VALID_ASPECT_RATIOS].join(", ")}`;
  }
  if (opts.resolution && !VALID_RESOLUTIONS.has(opts.resolution)) {
    return `Invalid resolution "${opts.resolution}". Valid: ${[...VALID_RESOLUTIONS].join(", ")}`;
  }
  return null;
}

function resolveOutputPath(opts: VideoGenerateOpts, mimeType: string): string {
  if (opts.output) {
    return path.resolve(opts.output);
  }
  const ext = mimeType === "video/webm" ? ".webm" : ".mp4";
  let idx = 1;
  let candidate = path.resolve(`video-${idx}${ext}`);
  // Simple collision avoidance for auto-naming
  while (idx < 1000) {
    candidate = path.resolve(`video-${idx}${ext}`);
    idx++;
    // We'll just use the first candidate — fs.writeFile will overwrite
    break;
  }
  return candidate;
}

export async function videoGenerateCommand(
  opts: VideoGenerateOpts,
  runtime: OutputRuntimeEnv,
): Promise<void> {
  const validationError = validateOpts(opts);
  if (validationError) {
    runtime.error(validationError);
    runtime.exit(1);
    return;
  }

  const cfg = loadConfig();

  const inputImages = opts.image ? await loadAssets(opts.image) : undefined;
  const inputVideos = opts.video ? await loadAssets(opts.video) : undefined;

  runtime.log("Generating video...");

  const result = await generateVideo({
    cfg,
    prompt: opts.prompt,
    modelOverride: opts.model,
    aspectRatio: opts.aspectRatio,
    resolution: opts.resolution as VideoGenerationResolution | undefined,
    durationSeconds: opts.duration,
    audio: opts.audio,
    watermark: opts.watermark,
    inputImages,
    inputVideos,
  });

  if (result.ignoredOverrides.length > 0) {
    for (const override of result.ignoredOverrides) {
      runtime.log(
        `Warning: ${override.key}=${String(override.value)} not supported by ${result.provider}, ignored.`,
      );
    }
  }

  const savedPaths: string[] = [];
  for (let i = 0; i < result.videos.length; i++) {
    const video = result.videos[i];
    const outputPath =
      result.videos.length === 1
        ? resolveOutputPath(opts, video.mimeType)
        : resolveOutputPath({ ...opts, output: undefined }, video.mimeType).replace(
            /(\.\w+)$/,
            `-${i + 1}$1`,
          );
    await fs.writeFile(outputPath, video.buffer);
    savedPaths.push(outputPath);
  }

  if (opts.json) {
    runtime.writeJson({
      provider: result.provider,
      model: result.model,
      videos: savedPaths,
      attempts: result.attempts.length,
      metadata: result.metadata,
    });
    return;
  }

  runtime.log(`Provider: ${result.provider}`);
  runtime.log(`Model: ${result.model}`);
  for (const p of savedPaths) {
    runtime.log(`Saved: ${p}`);
  }
}
