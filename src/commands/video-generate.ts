import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveAgentDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
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

  const mimeType = mimeMap[ext];
  if (!mimeType) {
    throw new Error(`Unsupported file type "${ext}" for asset: ${filePath}`);
  }
  return {
    buffer,
    mimeType,
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
  if (opts.aspectRatio && !/^\d+:\d+$/.test(opts.aspectRatio)) {
    return `Invalid aspect ratio format "${opts.aspectRatio}". Expected format: W:H (e.g. 16:9)`;
  }
  if (opts.resolution && !VALID_RESOLUTIONS.has(opts.resolution)) {
    return `Invalid resolution "${opts.resolution}". Valid: ${[...VALID_RESOLUTIONS].join(", ")}`;
  }
  return null;
}

async function resolveOutputPath(opts: VideoGenerateOpts, mimeType: string): Promise<string> {
  if (opts.output) {
    return path.resolve(opts.output);
  }
  const ext = mimeType === "video/webm" ? ".webm" : ".mp4";
  for (let idx = 1; idx < 1000; idx++) {
    const candidate = path.resolve(`video-${idx}${ext}`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  return path.resolve(`video-${Date.now()}${ext}`);
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
  const agentDir = resolveAgentDir(cfg, resolveDefaultAgentId(cfg));

  const inputImages = opts.image ? await loadAssets(opts.image) : undefined;
  const inputVideos = opts.video ? await loadAssets(opts.video) : undefined;

  if (!opts.json) {
    runtime.log("Generating video...");
  }

  const result = await generateVideo({
    cfg,
    agentDir,
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

  if (!opts.json && result.ignoredOverrides.length > 0) {
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
        ? await resolveOutputPath(opts, video.mimeType)
        : (await resolveOutputPath({ ...opts, output: undefined }, video.mimeType)).replace(
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
