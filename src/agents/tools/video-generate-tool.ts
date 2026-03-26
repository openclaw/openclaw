import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { saveMediaBuffer } from "../../media/store.js";
import {
  generateVideo,
  listRuntimeVideoGenerationProviders,
} from "../../video-generation/runtime.js";
import type { VideoGenerationProvider } from "../../video-generation/types.js";
import { ToolInputError, readBooleanParam, readNumberParam, readStringParam } from "./common.js";
import type { AnyAgentTool } from "./tool-runtime.helpers.js";

const SUPPORTED_ASPECT_RATIOS = new Set(["1:1", "3:4", "4:3", "9:16", "16:9", "21:9"]);

const VideoGenerateToolSchema = Type.Object({
  action: Type.Optional(
    Type.String({
      description:
        'Optional action: "generate" (default) or "list" to inspect available providers/models.',
    }),
  ),
  prompt: Type.Optional(Type.String({ description: "Video generation prompt." })),
  model: Type.Optional(
    Type.String({
      description: "Optional provider/model override, e.g. byteplus/seedance-1-5-pro-251215.",
    }),
  ),
  duration: Type.Optional(
    Type.Number({
      description: "Duration in seconds (typically 4-12).",
      minimum: 1,
      maximum: 60,
    }),
  ),
  aspectRatio: Type.Optional(
    Type.String({
      description: "Optional aspect ratio: 1:1, 3:4, 4:3, 9:16, 16:9, or 21:9.",
    }),
  ),
  resolution: Type.Optional(
    Type.String({
      description: "Optional resolution: 480p, 720p, or 1080p.",
    }),
  ),
  seed: Type.Optional(Type.Number({ description: "Random seed for reproducibility." })),
  watermark: Type.Optional(Type.Boolean({ description: "Add watermark to video." })),
  firstFrameImageUrl: Type.Optional(
    Type.String({
      description: "URL of the first frame reference image for image-to-video (I2V) generation.",
    }),
  ),
  lastFrameImageUrl: Type.Optional(
    Type.String({
      description: "URL of the last frame reference image for I2V generation.",
    }),
  ),
  camerafixed: Type.Optional(
    Type.Boolean({ description: "Fix camera position during generation." }),
  ),
  draft: Type.Optional(
    Type.Boolean({ description: "Draft mode for faster generation (forces 480p)." }),
  ),
});

function resolveAction(args: Record<string, unknown>): "generate" | "list" {
  const raw = readStringParam(args, "action");
  if (!raw) {
    return "generate";
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "generate" || normalized === "list") {
    return normalized;
  }
  throw new ToolInputError('action must be "generate" or "list"');
}

function buildListResponse(cfg?: OpenClawConfig): string {
  const providers = listRuntimeVideoGenerationProviders({ config: cfg });
  if (providers.length === 0) {
    return "No video generation providers available. Install a plugin that supports video generation.";
  }
  const lines: string[] = ["Available video generation providers:"];
  for (const provider of providers) {
    const models = provider.models ?? (provider.defaultModel ? [provider.defaultModel] : []);
    const capLines: string[] = [];
    if (provider.capabilities.aspectRatios?.length) {
      capLines.push(`aspect ratios: ${provider.capabilities.aspectRatios.join(", ")}`);
    }
    if (provider.capabilities.resolutions?.length) {
      capLines.push(`resolutions: ${provider.capabilities.resolutions.join(", ")}`);
    }
    if (provider.capabilities.maxDurationSeconds) {
      capLines.push(
        `duration: ${provider.capabilities.minDurationSeconds ?? 1}-${provider.capabilities.maxDurationSeconds}s`,
      );
    }
    lines.push(
      `- ${provider.id}${provider.label ? ` (${provider.label})` : ""}: ${models.join(", ")}${capLines.length > 0 ? ` [${capLines.join("; ")}]` : ""}`,
    );
  }
  return lines.join("\n");
}

function validateAspectRatio(
  requested: string | undefined,
  provider: VideoGenerationProvider | undefined,
): string | undefined {
  if (!requested) {
    return undefined;
  }
  const normalized = requested.trim();
  if (!SUPPORTED_ASPECT_RATIOS.has(normalized)) {
    throw new ToolInputError(
      `Unsupported aspect ratio "${normalized}". Supported: ${[...SUPPORTED_ASPECT_RATIOS].join(", ")}`,
    );
  }
  if (
    provider?.capabilities.aspectRatios?.length &&
    !provider.capabilities.aspectRatios.includes(normalized)
  ) {
    throw new ToolInputError(
      `Provider does not support aspect ratio "${normalized}". Supported: ${provider.capabilities.aspectRatios.join(", ")}`,
    );
  }
  return normalized;
}

export function createVideoGenerateTool(params: {
  config?: OpenClawConfig;
  agentDir?: string;
}): AnyAgentTool | null {
  const providers = listRuntimeVideoGenerationProviders({ config: params.config });
  if (providers.length === 0) {
    return null;
  }

  return {
    label: "Video Generation",
    name: "video_generate",
    description:
      'Generate a short video from a text prompt. Returns a saved video file path. Use action="list" to see available providers, models, and capabilities. Generated videos are delivered automatically from the tool result as MEDIA paths.',
    parameters: VideoGenerateToolSchema,
    execute: async (_toolCallId, args) => {
      const rawArgs = args as Record<string, unknown>;
      const cfg = params.config ?? loadConfig();
      const action = resolveAction(rawArgs);

      if (action === "list") {
        return {
          content: [{ type: "text", text: buildListResponse(cfg) }],
          details: {},
        };
      }

      const prompt = readStringParam(rawArgs, "prompt");
      if (!prompt?.trim()) {
        throw new ToolInputError("prompt is required for video generation");
      }

      const modelOverride = readStringParam(rawArgs, "model");
      const duration = readNumberParam(rawArgs, "duration", { integer: true });
      const aspectRatio = readStringParam(rawArgs, "aspectRatio");
      const resolution = readStringParam(rawArgs, "resolution");
      const seed = readNumberParam(rawArgs, "seed", { integer: true });
      const watermark = readBooleanParam(rawArgs, "watermark");
      const firstFrameImageUrl = readStringParam(rawArgs, "firstFrameImageUrl");
      const lastFrameImageUrl = readStringParam(rawArgs, "lastFrameImageUrl");
      const camerafixed = readBooleanParam(rawArgs, "camerafixed");
      const draft = readBooleanParam(rawArgs, "draft");

      const currentProviders = listRuntimeVideoGenerationProviders({ config: cfg });
      const parsedOverride = modelOverride?.includes("/")
        ? { provider: modelOverride.split("/")[0] }
        : null;
      const validationProvider = parsedOverride
        ? (currentProviders.find((p) => p.id === parsedOverride.provider) ?? currentProviders[0])
        : currentProviders[0];
      const validatedAspectRatio = validateAspectRatio(aspectRatio, validationProvider);

      const providerOptions: Record<string, unknown> = {};
      if (camerafixed != null) {
        providerOptions.camerafixed = camerafixed;
      }
      if (draft != null) {
        providerOptions.draft = draft;
      }

      const result = await generateVideo({
        cfg,
        prompt: prompt.trim(),
        agentDir: params.agentDir,
        modelOverride,
        durationSeconds: duration,
        aspectRatio: validatedAspectRatio,
        resolution: resolution?.trim(),
        seed,
        watermark,
        firstFrameImageUrl,
        lastFrameImageUrl,
        providerOptions: Object.keys(providerOptions).length > 0 ? providerOptions : undefined,
      });

      const VIDEO_MAX_BYTES = 200 * 1024 * 1024; // 200MB for generated videos
      const savedVideos = await Promise.all(
        result.videos.map((video) =>
          saveMediaBuffer(
            video.buffer,
            video.mimeType,
            "tool-video-generation",
            VIDEO_MAX_BYTES,
            video.fileName,
          ),
        ),
      );

      const lines = [
        `Generated ${savedVideos.length} video${savedVideos.length === 1 ? "" : "s"} with ${result.provider}/${result.model}.`,
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          provider: result.provider,
          model: result.model,
          count: savedVideos.length,
          media: {
            mediaUrls: savedVideos.map((video) => video.path),
          },
          paths: savedVideos.map((video) => video.path),
          ...(duration ? { duration } : {}),
          ...(validatedAspectRatio ? { aspectRatio: validatedAspectRatio } : {}),
          ...(resolution ? { resolution } : {}),
          attempts: result.attempts,
          metadata: result.metadata,
        },
      };
    },
  };
}
