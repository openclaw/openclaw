import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { saveMediaBuffer } from "../../media/store.js";
import { loadWebMedia } from "../../media/web-media.js";
import { parseMusicGenerationModelRef } from "../../music-generation/model-ref.js";
import {
  generateMusic,
  listRuntimeMusicGenerationProviders,
} from "../../music-generation/runtime.js";
import type { MusicGenerationOutputFormat } from "../../music-generation/types.js";
import type {
  MusicGenerationProvider,
  MusicGenerationSourceImage,
} from "../../music-generation/types.js";
import { readSnakeCaseParamRaw } from "../../param-key.js";
import { resolveUserPath } from "../../utils.js";
import type { DeliveryContext } from "../../utils/delivery-context.js";
import {
  ToolInputError,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "./common.js";
import { decodeDataUrl } from "./image-tool.helpers.js";
import {
  applyMusicGenerationModelConfigDefaults,
  findCapabilityProviderById,
  resolveCapabilityModelConfigForTool,
  resolveMediaToolLocalRoots,
} from "./media-tool-shared.js";
import { type ToolModelConfig } from "./model-config.helpers.js";
import {
  completeMusicGenerationTaskRun,
  createMusicGenerationTaskRun,
  failMusicGenerationTaskRun,
  recordMusicGenerationTaskProgress,
  type MusicGenerationTaskHandle,
  wakeMusicGenerationTaskCompletion,
} from "./music-generate-background.js";
import {
  createMusicGenerateDuplicateGuardResult,
  createMusicGenerateListActionResult,
  createMusicGenerateStatusActionResult,
} from "./music-generate-tool.actions.js";
import {
  createSandboxBridgeReadFile,
  resolveSandboxedBridgeMediaPath,
  type AnyAgentTool,
  type SandboxFsBridge,
  type ToolFsPolicy,
} from "./tool-runtime.helpers.js";

const log = createSubsystemLogger("agents/tools/music-generate");
const MAX_INPUT_IMAGES = 10;
const SUPPORTED_OUTPUT_FORMATS = new Set<MusicGenerationOutputFormat>(["mp3", "wav"]);

const MusicGenerateToolSchema = Type.Object({
  action: Type.Optional(
    Type.String({
      description:
        'Optional action: "generate" (default), "status" to inspect the active session task, or "list" to inspect available providers/models.',
    }),
  ),
  prompt: Type.Optional(Type.String({ description: "Music generation prompt." })),
  lyrics: Type.Optional(
    Type.String({
      description: "Optional lyrics to guide sung output when the provider supports it.",
    }),
  ),
  instrumental: Type.Optional(
    Type.Boolean({
      description: "Optional toggle for instrumental-only output when the provider supports it.",
    }),
  ),
  image: Type.Optional(
    Type.String({
      description: "Optional single reference image path or URL.",
    }),
  ),
  images: Type.Optional(
    Type.Array(Type.String(), {
      description: `Optional reference images (up to ${MAX_INPUT_IMAGES}).`,
    }),
  ),
  model: Type.Optional(
    Type.String({
      description: "Optional provider/model override, e.g. google/lyria-3-pro-preview.",
    }),
  ),
  durationSeconds: Type.Optional(
    Type.Number({
      description: "Optional target duration in seconds when the provider supports duration hints.",
      minimum: 1,
    }),
  ),
  format: Type.Optional(
    Type.String({
      description: 'Optional output format hint: "mp3" or "wav" when the provider supports it.',
    }),
  ),
  filename: Type.Optional(
    Type.String({
      description:
        "Optional output filename hint. OpenClaw preserves the basename and saves under its managed media directory.",
    }),
  ),
});

export function resolveMusicGenerationModelConfigForTool(params: {
  cfg?: OpenClawConfig;
  agentDir?: string;
}): ToolModelConfig | null {
  return resolveCapabilityModelConfigForTool({
    cfg: params.cfg,
    agentDir: params.agentDir,
    modelConfig: params.cfg?.agents?.defaults?.musicGenerationModel,
    providers: listRuntimeMusicGenerationProviders({ config: params.cfg }),
  });
}

function resolveSelectedMusicGenerationProvider(params: {
  config?: OpenClawConfig;
  musicGenerationModelConfig: ToolModelConfig;
  modelOverride?: string;
}): MusicGenerationProvider | undefined {
  const selectedRef =
    parseMusicGenerationModelRef(params.modelOverride) ??
    parseMusicGenerationModelRef(params.musicGenerationModelConfig.primary);
  if (!selectedRef) {
    return undefined;
  }
  return findCapabilityProviderById({
    providers: listRuntimeMusicGenerationProviders({ config: params.config }),
    providerId: selectedRef.provider,
  });
}

function resolveAction(args: Record<string, unknown>): "generate" | "list" | "status" {
  const raw = readStringParam(args, "action");
  if (!raw) {
    return "generate";
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "generate" || normalized === "list" || normalized === "status") {
    return normalized;
  }
  throw new ToolInputError('action must be "generate", "status", or "list"');
}

function readBooleanParam(params: Record<string, unknown>, key: string): boolean | undefined {
  const raw = readSnakeCaseParamRaw(params, key);
  if (typeof raw === "boolean") {
    return raw;
  }
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return undefined;
}

function normalizeOutputFormat(raw: string | undefined): MusicGenerationOutputFormat | undefined {
  const normalized = raw?.trim().toLowerCase() as MusicGenerationOutputFormat | undefined;
  if (!normalized) {
    return undefined;
  }
  if (SUPPORTED_OUTPUT_FORMATS.has(normalized)) {
    return normalized;
  }
  throw new ToolInputError('format must be one of "mp3" or "wav"');
}

function normalizeReferenceImageInputs(args: Record<string, unknown>): string[] {
  const single = readStringParam(args, "image");
  const multiple = readStringArrayParam(args, "images");
  const combined = [...(single ? [single] : []), ...(multiple ?? [])];
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const candidate of combined) {
    const trimmed = candidate.trim();
    const dedupe = trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed;
    if (!dedupe || seen.has(dedupe)) {
      continue;
    }
    seen.add(dedupe);
    deduped.push(trimmed);
  }
  if (deduped.length > MAX_INPUT_IMAGES) {
    throw new ToolInputError(
      `Too many reference images: ${deduped.length} provided, maximum is ${MAX_INPUT_IMAGES}.`,
    );
  }
  return deduped;
}

function validateMusicGenerationCapabilities(params: {
  provider: MusicGenerationProvider | undefined;
  model?: string;
  inputImageCount: number;
  lyrics?: string;
  instrumental?: boolean;
  durationSeconds?: number;
  format?: MusicGenerationOutputFormat;
}) {
  const provider = params.provider;
  if (!provider) {
    return;
  }
  const caps = provider.capabilities;
  if (params.inputImageCount > 0) {
    const maxInputImages = caps.maxInputImages ?? MAX_INPUT_IMAGES;
    if (params.inputImageCount > maxInputImages) {
      throw new ToolInputError(
        `${provider.id} supports at most ${maxInputImages} reference image${maxInputImages === 1 ? "" : "s"}.`,
      );
    }
  }
  if (params.lyrics?.trim() && !caps.supportsLyrics) {
    throw new ToolInputError(`${provider.id} does not support explicit lyrics input.`);
  }
  if (typeof params.instrumental === "boolean" && !caps.supportsInstrumental) {
    throw new ToolInputError(`${provider.id} does not support instrumental toggles.`);
  }
  if (typeof params.durationSeconds === "number" && !caps.supportsDuration) {
    throw new ToolInputError(`${provider.id} does not support duration hints.`);
  }
  if (typeof params.durationSeconds === "number" && typeof caps.maxDurationSeconds === "number") {
    if (params.durationSeconds > caps.maxDurationSeconds) {
      throw new ToolInputError(
        `${provider.id} supports at most ${caps.maxDurationSeconds} seconds per track.`,
      );
    }
  }
  if (params.format) {
    if (!caps.supportsFormat) {
      throw new ToolInputError(`${provider.id} does not support explicit output-format overrides.`);
    }
    const supportedFormats =
      caps.supportedFormatsByModel?.[params.model ?? ""] ?? caps.supportedFormats ?? [];
    if (supportedFormats.length > 0 && !supportedFormats.includes(params.format)) {
      throw new ToolInputError(
        `${provider.id} supports ${supportedFormats.join(", ")} output${params.model ? ` for ${params.model}` : ""}.`,
      );
    }
  }
}

type MusicGenerateSandboxConfig = {
  root: string;
  bridge: SandboxFsBridge;
};

type MusicGenerateBackgroundScheduler = (work: () => Promise<void>) => void;

function defaultScheduleMusicGenerateBackgroundWork(work: () => Promise<void>) {
  queueMicrotask(() => {
    void work().catch((error) => {
      log.error("Detached music generation job crashed", {
        error,
      });
    });
  });
}

async function loadReferenceImages(params: {
  inputs: string[];
  workspaceDir?: string;
  sandboxConfig: { root: string; bridge: SandboxFsBridge; workspaceOnly: boolean } | null;
}): Promise<
  Array<{
    sourceImage: MusicGenerationSourceImage;
    resolvedInput: string;
    rewrittenFrom?: string;
  }>
> {
  const loaded: Array<{
    sourceImage: MusicGenerationSourceImage;
    resolvedInput: string;
    rewrittenFrom?: string;
  }> = [];

  for (const rawInput of params.inputs) {
    const trimmed = rawInput.trim();
    const inputRaw = trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed;
    if (!inputRaw) {
      throw new ToolInputError("image required (empty string in array)");
    }
    const looksLikeWindowsDrivePath = /^[a-zA-Z]:[\\/]/.test(inputRaw);
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(inputRaw);
    const isFileUrl = /^file:/i.test(inputRaw);
    const isHttpUrl = /^https?:\/\//i.test(inputRaw);
    const isDataUrl = /^data:/i.test(inputRaw);
    if (hasScheme && !looksLikeWindowsDrivePath && !isFileUrl && !isHttpUrl && !isDataUrl) {
      throw new ToolInputError(
        `Unsupported image reference: ${rawInput}. Use a file path, a file:// URL, a data: URL, or an http(s) URL.`,
      );
    }
    if (params.sandboxConfig && isHttpUrl) {
      throw new ToolInputError("Sandboxed music_generate does not allow remote image URLs.");
    }

    const resolvedInput = params.sandboxConfig
      ? inputRaw
      : inputRaw.startsWith("~")
        ? resolveUserPath(inputRaw)
        : inputRaw;
    const resolvedPathInfo: { resolved: string; rewrittenFrom?: string } = isDataUrl
      ? { resolved: "" }
      : params.sandboxConfig
        ? await resolveSandboxedBridgeMediaPath({
            sandbox: params.sandboxConfig,
            mediaPath: resolvedInput,
            inboundFallbackDir: "media/inbound",
          })
        : {
            resolved: resolvedInput.startsWith("file://")
              ? resolvedInput.slice("file://".length)
              : resolvedInput,
          };
    const resolvedPath = isDataUrl ? null : resolvedPathInfo.resolved;
    const localRoots = resolveMediaToolLocalRoots(
      params.workspaceDir,
      {
        workspaceOnly: params.sandboxConfig?.workspaceOnly === true,
      },
      resolvedPath ? [resolvedPath] : undefined,
    );
    const media = isDataUrl
      ? decodeDataUrl(resolvedInput)
      : params.sandboxConfig
        ? await loadWebMedia(resolvedPath ?? resolvedInput, {
            sandboxValidated: true,
            readFile: createSandboxBridgeReadFile({ sandbox: params.sandboxConfig }),
          })
        : await loadWebMedia(resolvedPath ?? resolvedInput, {
            localRoots,
          });
    if (media.kind !== "image") {
      throw new ToolInputError(`Unsupported media type: ${media.kind ?? "unknown"}`);
    }
    const mimeType = "mimeType" in media ? media.mimeType : media.contentType;
    const fileName = "fileName" in media ? media.fileName : undefined;
    loaded.push({
      sourceImage: {
        buffer: media.buffer,
        mimeType,
        fileName,
      },
      resolvedInput,
      ...(resolvedPathInfo.rewrittenFrom ? { rewrittenFrom: resolvedPathInfo.rewrittenFrom } : {}),
    });
  }

  return loaded;
}

type LoadedReferenceImage = Awaited<ReturnType<typeof loadReferenceImages>>[number];

type ExecutedMusicGeneration = {
  provider: string;
  model: string;
  savedPaths: string[];
  contentText: string;
  details: Record<string, unknown>;
  wakeResult: string;
};

async function executeMusicGenerationJob(params: {
  effectiveCfg: OpenClawConfig;
  prompt: string;
  agentDir?: string;
  model?: string;
  lyrics?: string;
  instrumental?: boolean;
  durationSeconds?: number;
  format?: MusicGenerationOutputFormat;
  filename?: string;
  loadedReferenceImages: LoadedReferenceImage[];
  taskHandle?: MusicGenerationTaskHandle | null;
}): Promise<ExecutedMusicGeneration> {
  if (params.taskHandle) {
    recordMusicGenerationTaskProgress({
      handle: params.taskHandle,
      progressSummary: "Generating music",
    });
  }
  const result = await generateMusic({
    cfg: params.effectiveCfg,
    prompt: params.prompt,
    agentDir: params.agentDir,
    modelOverride: params.model,
    lyrics: params.lyrics,
    instrumental: params.instrumental,
    durationSeconds: params.durationSeconds,
    format: params.format,
    inputImages: params.loadedReferenceImages.map((entry) => entry.sourceImage),
  });
  if (params.taskHandle) {
    recordMusicGenerationTaskProgress({
      handle: params.taskHandle,
      progressSummary: "Saving generated music",
    });
  }
  const savedTracks = await Promise.all(
    result.tracks.map((track) =>
      saveMediaBuffer(
        track.buffer,
        track.mimeType,
        "tool-music-generation",
        undefined,
        params.filename || track.fileName,
      ),
    ),
  );
  const lines = [
    `Generated ${savedTracks.length} track${savedTracks.length === 1 ? "" : "s"} with ${result.provider}/${result.model}.`,
    ...(result.lyrics?.length ? ["Lyrics returned.", ...result.lyrics] : []),
    ...savedTracks.map((track) => `MEDIA:${track.path}`),
  ];
  return {
    provider: result.provider,
    model: result.model,
    savedPaths: savedTracks.map((track) => track.path),
    contentText: lines.join("\n"),
    wakeResult: lines.join("\n"),
    details: {
      provider: result.provider,
      model: result.model,
      count: savedTracks.length,
      media: {
        mediaUrls: savedTracks.map((track) => track.path),
      },
      paths: savedTracks.map((track) => track.path),
      ...(params.taskHandle
        ? {
            task: {
              taskId: params.taskHandle.taskId,
              runId: params.taskHandle.runId,
            },
          }
        : {}),
      ...(params.lyrics ? { requestedLyrics: params.lyrics } : {}),
      ...(typeof params.instrumental === "boolean" ? { instrumental: params.instrumental } : {}),
      ...(typeof params.durationSeconds === "number"
        ? { durationSeconds: params.durationSeconds }
        : {}),
      ...(params.format ? { format: params.format } : {}),
      ...(params.filename ? { filename: params.filename } : {}),
      ...(params.loadedReferenceImages.length === 1
        ? {
            image: params.loadedReferenceImages[0]?.resolvedInput,
            ...(params.loadedReferenceImages[0]?.rewrittenFrom
              ? { rewrittenFrom: params.loadedReferenceImages[0].rewrittenFrom }
              : {}),
          }
        : params.loadedReferenceImages.length > 1
          ? {
              images: params.loadedReferenceImages.map((entry) => ({
                image: entry.resolvedInput,
                ...(entry.rewrittenFrom ? { rewrittenFrom: entry.rewrittenFrom } : {}),
              })),
            }
          : {}),
      ...(result.lyrics?.length ? { lyrics: result.lyrics } : {}),
      attempts: result.attempts,
      metadata: result.metadata,
    },
  };
}

export function createMusicGenerateTool(options?: {
  config?: OpenClawConfig;
  agentDir?: string;
  agentSessionKey?: string;
  requesterOrigin?: DeliveryContext;
  workspaceDir?: string;
  sandbox?: MusicGenerateSandboxConfig;
  fsPolicy?: ToolFsPolicy;
  scheduleBackgroundWork?: MusicGenerateBackgroundScheduler;
}): AnyAgentTool | null {
  const cfg: OpenClawConfig = options?.config ?? loadConfig();
  const musicGenerationModelConfig = resolveMusicGenerationModelConfigForTool({
    cfg,
    agentDir: options?.agentDir,
  });
  if (!musicGenerationModelConfig) {
    return null;
  }

  const sandboxConfig = options?.sandbox
    ? {
        root: options.sandbox.root,
        bridge: options.sandbox.bridge,
        workspaceOnly: options.fsPolicy?.workspaceOnly === true,
      }
    : null;
  const scheduleBackgroundWork =
    options?.scheduleBackgroundWork ?? defaultScheduleMusicGenerateBackgroundWork;

  return {
    label: "Music Generation",
    name: "music_generate",
    displaySummary: "Generate music",
    description:
      "Generate music using configured providers. Generated tracks are saved under OpenClaw-managed media storage and delivered automatically as attachments.",
    parameters: MusicGenerateToolSchema,
    execute: async (_toolCallId, rawArgs) => {
      const args = rawArgs as Record<string, unknown>;
      const action = resolveAction(args);
      const effectiveCfg =
        applyMusicGenerationModelConfigDefaults(cfg, musicGenerationModelConfig) ?? cfg;

      if (action === "list") {
        return createMusicGenerateListActionResult(effectiveCfg);
      }

      if (action === "status") {
        return createMusicGenerateStatusActionResult(options?.agentSessionKey);
      }

      const duplicateGuardResult = createMusicGenerateDuplicateGuardResult(
        options?.agentSessionKey,
      );
      if (duplicateGuardResult) {
        return duplicateGuardResult;
      }

      const prompt = readStringParam(args, "prompt", { required: true });
      const lyrics = readStringParam(args, "lyrics");
      const instrumental = readBooleanParam(args, "instrumental");
      const model = readStringParam(args, "model");
      const durationSeconds = readNumberParam(args, "durationSeconds", {
        integer: true,
        strict: true,
      });
      const format = normalizeOutputFormat(readStringParam(args, "format"));
      const filename = readStringParam(args, "filename");
      const imageInputs = normalizeReferenceImageInputs(args);
      const selectedProvider = resolveSelectedMusicGenerationProvider({
        config: effectiveCfg,
        musicGenerationModelConfig,
        modelOverride: model,
      });
      const loadedReferenceImages = await loadReferenceImages({
        inputs: imageInputs,
        workspaceDir: options?.workspaceDir,
        sandboxConfig,
      });
      validateMusicGenerationCapabilities({
        provider: selectedProvider,
        model:
          parseMusicGenerationModelRef(model)?.model ?? model ?? selectedProvider?.defaultModel,
        inputImageCount: loadedReferenceImages.length,
        lyrics,
        instrumental,
        durationSeconds,
        format,
      });
      const taskHandle = createMusicGenerationTaskRun({
        sessionKey: options?.agentSessionKey,
        requesterOrigin: options?.requesterOrigin,
        prompt,
        providerId: selectedProvider?.id,
      });
      const shouldDetach = Boolean(taskHandle && options?.agentSessionKey?.trim());

      if (shouldDetach) {
        scheduleBackgroundWork(async () => {
          try {
            const executed = await executeMusicGenerationJob({
              effectiveCfg,
              prompt,
              agentDir: options?.agentDir,
              model,
              lyrics,
              instrumental,
              durationSeconds,
              format,
              filename,
              loadedReferenceImages,
              taskHandle,
            });
            completeMusicGenerationTaskRun({
              handle: taskHandle,
              provider: executed.provider,
              model: executed.model,
              count: executed.savedPaths.length,
              paths: executed.savedPaths,
            });
            try {
              await wakeMusicGenerationTaskCompletion({
                handle: taskHandle,
                status: "ok",
                statusLabel: "completed successfully",
                result: executed.wakeResult,
              });
            } catch (error) {
              log.warn("Music generation completion wake failed after successful generation", {
                taskId: taskHandle?.taskId,
                runId: taskHandle?.runId,
                error,
              });
            }
          } catch (error) {
            failMusicGenerationTaskRun({
              handle: taskHandle,
              error,
            });
            await wakeMusicGenerationTaskCompletion({
              handle: taskHandle,
              status: "error",
              statusLabel: "failed",
              result: error instanceof Error ? error.message : String(error),
            });
            return;
          }
        });

        return {
          content: [
            {
              type: "text",
              text: `Background task started for music generation (${taskHandle?.taskId ?? "unknown"}). Do not call music_generate again for this request. Wait for the completion event; I'll post the finished music here when it's ready.`,
            },
          ],
          details: {
            async: true,
            status: "started",
            ...(taskHandle
              ? {
                  task: {
                    taskId: taskHandle.taskId,
                    runId: taskHandle.runId,
                  },
                }
              : {}),
            ...(loadedReferenceImages.length === 1
              ? {
                  image: loadedReferenceImages[0]?.resolvedInput,
                  ...(loadedReferenceImages[0]?.rewrittenFrom
                    ? { rewrittenFrom: loadedReferenceImages[0].rewrittenFrom }
                    : {}),
                }
              : loadedReferenceImages.length > 1
                ? {
                    images: loadedReferenceImages.map((entry) => ({
                      image: entry.resolvedInput,
                      ...(entry.rewrittenFrom ? { rewrittenFrom: entry.rewrittenFrom } : {}),
                    })),
                  }
                : {}),
            ...(model ? { model } : {}),
            ...(lyrics ? { requestedLyrics: lyrics } : {}),
            ...(typeof instrumental === "boolean" ? { instrumental } : {}),
            ...(typeof durationSeconds === "number" ? { durationSeconds } : {}),
            ...(format ? { format } : {}),
            ...(filename ? { filename } : {}),
          },
        };
      }

      try {
        const executed = await executeMusicGenerationJob({
          effectiveCfg,
          prompt,
          agentDir: options?.agentDir,
          lyrics,
          instrumental,
          durationSeconds,
          model,
          format,
          filename,
          loadedReferenceImages,
          taskHandle,
        });
        completeMusicGenerationTaskRun({
          handle: taskHandle,
          provider: executed.provider,
          model: executed.model,
          count: executed.savedPaths.length,
          paths: executed.savedPaths,
        });
        return {
          content: [{ type: "text", text: executed.contentText }],
          details: executed.details,
        };
      } catch (error) {
        failMusicGenerationTaskRun({
          handle: taskHandle,
          error,
        });
        throw error;
      }
    },
  };
}
