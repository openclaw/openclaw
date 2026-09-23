/** Runs music generation, persistence, and detached completion. */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { Type } from "typebox";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SsrFPolicy } from "../../infra/net/ssrf.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { parseMusicGenerationModelRef } from "../../media-generation/model-ref.js";
import { resolveGeneratedMediaMaxBytes } from "../../media/configured-max-bytes.js";
import { listRuntimeMusicGenerationProviders } from "../../music-generation/runtime.js";
import type {
  MusicGenerationOutputFormat,
  MusicGenerationProvider,
  MusicGenerationSourceImage,
} from "../../music-generation/types.js";
import { readSnakeCaseParamRaw } from "../../param-key.js";
import { readBooleanParam } from "../../plugin-sdk/boolean-param.js";
import { buildMediaGenerationRequestKey } from "../media-generation-task-status-shared.js";
import { ToolInputError, readNumberParam, readToolStringParam } from "./common.js";
import { createDefaultMediaGenerateBackgroundScheduler } from "./media-generate-background-shared.js";
import {
  musicGenerationTaskLifecycle,
  prepareMediaGenerationTask,
  type MediaGenerateToolOptions,
  type MusicGenerationTaskHandle,
} from "./media-generate-background.js";
import { acquireMusicGenerationToolProviders } from "./media-generation-tool-providers.js";
import {
  buildMediaReferenceDetails,
  hasGenerationToolAvailability,
  loadMediaToolReferences,
  normalizeMediaReferenceInputs,
  resolveMediaToolSandboxConfig,
  resolveGenerateAction,
  resolveRemoteMediaSsrfPolicy,
  resolveSelectedCapabilityProvider,
} from "./media-tool-shared.js";
import type { ToolModelConfig } from "./model-config.helpers.js";
import {
  createMusicGenerateDuplicateGuardResult,
  createMusicGenerateListActionResult,
  createMusicGenerateStatusActionResult,
} from "./music-generate-tool.actions.js";
import {
  executeMusicGenerationJob,
  normalizeMusicGenerationTimeoutMs,
} from "./music-generate-tool.execution.js";
import type { AnyAgentTool, ToolFsPolicy } from "./tool-runtime.helpers.js";

const log = createSubsystemLogger("agents/tools/music-generate");
const MAX_INPUT_IMAGES = 10;
const SUPPORTED_OUTPUT_FORMATS = new Set<MusicGenerationOutputFormat>(["mp3", "wav"]);

const MusicGenerateToolSchema = Type.Object({
  action: Type.Optional(
    Type.String({
      description: '"generate" default, "status" active task, "list" providers/models.',
    }),
  ),
  prompt: Type.Optional(Type.String({ description: "Music prompt: style, genre, mood, purpose." })),
  lyrics: Type.Optional(
    Type.String({
      description:
        "Exact sung lyrics only when the user supplies lyrics or asks for vocal words. For song/style requests, use prompt instead.",
    }),
  ),
  instrumental: Type.Optional(
    Type.Boolean({
      description: "Instrumental-only toggle.",
    }),
  ),
  image: Type.Optional(
    Type.String({
      description: "Reference image path/URL.",
    }),
  ),
  images: Type.Optional(
    Type.Array(Type.String(), {
      description: `Reference images; max ${MAX_INPUT_IMAGES}.`,
    }),
  ),
  model: Type.Optional(
    Type.String({
      description: "Provider/model override, e.g. google/lyria-3-pro-preview.",
    }),
  ),
  durationSeconds: Type.Optional(
    Type.Integer({
      description: "Target seconds; provider may clamp.",
      minimum: 1,
    }),
  ),
  format: Type.Optional(
    Type.String({
      description: "Output format: mp3, wav.",
    }),
  ),
  filename: Type.Optional(
    Type.String({
      description: "Output filename hint; basename preserved in managed media dir.",
    }),
  ),
});

function resolveSelectedMusicGenerationProvider(params: {
  config?: OpenClawConfig;
  providers?: MusicGenerationProvider[];
  musicGenerationModelConfig: ToolModelConfig;
  modelOverride?: string;
}): MusicGenerationProvider | undefined {
  return resolveSelectedCapabilityProvider({
    providers: params.providers ?? listRuntimeMusicGenerationProviders({ config: params.config }),
    modelConfig: params.musicGenerationModelConfig,
    modelOverride: params.modelOverride,
    parseModelRef: parseMusicGenerationModelRef,
  });
}

function normalizeOutputFormat(raw: string | undefined): MusicGenerationOutputFormat | undefined {
  const normalized = normalizeOptionalLowercaseString(raw) as
    | MusicGenerationOutputFormat
    | undefined;
  if (!normalized) {
    return undefined;
  }
  if (SUPPORTED_OUTPUT_FORMATS.has(normalized)) {
    return normalized;
  }
  throw new ToolInputError('format must be one of "mp3" or "wav"');
}

function normalizeReferenceImageInputs(args: Record<string, unknown>): string[] {
  return normalizeMediaReferenceInputs({
    args,
    singularKey: "image",
    pluralKey: "images",
    maxCount: MAX_INPUT_IMAGES,
    label: "reference images",
  });
}

const defaultScheduleMusicGenerateBackgroundWork = createDefaultMediaGenerateBackgroundScheduler({
  toolName: "music_generate",
  onCrash: (message, meta) => log.error(message, meta),
});

async function loadReferenceImages(params: {
  inputs: string[];
  maxBytes: number;
  workspaceDir?: string;
  cwd?: string;
  fsPolicy?: ToolFsPolicy;
  sandboxConfig: ReturnType<typeof resolveMediaToolSandboxConfig>;
  ssrfPolicy?: SsrFPolicy;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<
  Array<{
    sourceImage: MusicGenerationSourceImage;
    resolvedInput: string;
    rewrittenFrom?: string;
  }>
> {
  const loaded = await loadMediaToolReferences<MusicGenerationSourceImage>({
    inputs: params.inputs,
    toolName: "music_generate",
    expectedKind: "image",
    sandbox: params.sandboxConfig,
    workspaceDir: params.workspaceDir,
    cwd: params.cwd,
    fsPolicy: params.fsPolicy,
    maxBytes: params.maxBytes,
    ssrfPolicy: params.ssrfPolicy,
    timeoutMs: params.timeoutMs,
    signal: params.signal,
    mapMedia: (media) => ({
      buffer: media.buffer,
      mimeType: "mimeType" in media ? media.mimeType : media.contentType,
      fileName: "fileName" in media ? media.fileName : undefined,
    }),
  });
  return loaded.map(({ source, resolvedInput, rewrittenFrom }) =>
    Object.assign({ sourceImage: source, resolvedInput }, rewrittenFrom ? { rewrittenFrom } : {}),
  );
}

export function createMusicGenerateTool(options?: MediaGenerateToolOptions): AnyAgentTool | null {
  const cfg: OpenClawConfig = options?.config ?? getRuntimeConfig();
  const preparedProviders = options?.preparedModelRuntime?.mediaCapabilityProviders
    ?.musicGenerationProviders
    ? [...options.preparedModelRuntime.mediaCapabilityProviders.musicGenerationProviders]
    : undefined;
  if (
    !hasGenerationToolAvailability({
      cfg,
      agentDir: options?.agentDir,
      workspaceDir: options?.workspaceDir,
      authStore: options?.authProfileStore,
      modelConfig: cfg.agents?.defaults?.mediaModels?.music,
      providerKey: "musicGenerationProviders",
      providers: preparedProviders,
    })
  ) {
    return null;
  }

  const sandboxConfig = resolveMediaToolSandboxConfig(
    options?.sandbox,
    options?.fsPolicy?.workspaceOnly,
  );
  const scheduleBackgroundWork =
    options?.scheduleBackgroundWork ?? defaultScheduleMusicGenerateBackgroundWork;

  return {
    label: "Music Generation",
    name: "music_generate",
    displaySummary: "Generate music",
    description:
      "Create song/jingle/beat/loop/soundtrack/anthem/instrumental. Make/generate music => call; lyrics-only request => text only. prompt: style/genre/mood/tempo/instruments/purpose; lyrics: exact sung words; image/images condition on reference image(s). action=list discovers providers/models. Session chat background: call once/request, await, then visible reply + structured media. status checks active task.",
    parameters: MusicGenerateToolSchema,
    execute: async (_toolCallId, rawArgs, signal) => {
      const args = rawArgs as Record<string, unknown>;
      const action = resolveGenerateAction(args);

      if (action === "list") {
        return createMusicGenerateListActionResult(cfg, {
          workspaceDir: options?.workspaceDir,
          agentDir: options?.agentDir,
          authStore: options?.authProfileStore,
        });
      }

      if (action === "status") {
        return createMusicGenerateStatusActionResult(
          options?.agentSessionKey,
          options?.requesterAgentId,
        );
      }

      const model = readToolStringParam(args, "model");
      return prepareMediaGenerationTask({
        generationLabel: "music",
        cfg,
        args,
        model,
        options,
        signal,
        findDuplicate: createMusicGenerateDuplicateGuardResult,
        acquire: async (config) =>
          options?.preparedModelRuntime?.acquireMediaCapabilityProviders
            ? acquireMusicGenerationToolProviders({
                cfg: config,
                prepared: options.preparedModelRuntime,
              })
            : undefined,
        resolveProviders: (acquired) =>
          acquired?.providers ?? (() => listRuntimeMusicGenerationProviders({ config: cfg })),
        prepare: async ({
          resources: acquired,
          modelConfig: musicGenerationModelConfig,
          effectiveCfg,
          prompt,
          explicitModelConfig,
        }) => {
          const providers = acquired?.providers ?? preparedProviders;

          const lyrics = readToolStringParam(args, "lyrics");
          const instrumental = readBooleanParam(args, "instrumental");
          const durationSeconds = readNumberParam(args, "durationSeconds", {
            positiveInteger: true,
            strict: true,
          });
          if (
            durationSeconds === undefined &&
            readSnakeCaseParamRaw(args, "durationSeconds") !== undefined
          ) {
            throw new ToolInputError("durationSeconds must be a positive integer");
          }
          const format = normalizeOutputFormat(readToolStringParam(args, "format"));
          const filename = readToolStringParam(args, "filename");
          const timeout = normalizeMusicGenerationTimeoutMs(musicGenerationModelConfig.timeoutMs);
          const timeoutMs = timeout.timeoutMs;
          const imageInputs = normalizeReferenceImageInputs(args);
          const explicitModelRef = parseMusicGenerationModelRef(model);
          const primaryModelRef = parseMusicGenerationModelRef(musicGenerationModelConfig.primary);
          const selectedModelRef = explicitModelRef ?? primaryModelRef;
          const shouldResolveSelectedProvider =
            imageInputs.length > 0 ||
            (model !== undefined && !explicitModelRef) ||
            (model === undefined && !primaryModelRef);
          const selectedProvider = shouldResolveSelectedProvider
            ? resolveSelectedMusicGenerationProvider({
                config: effectiveCfg,
                providers,
                musicGenerationModelConfig,
                modelOverride: model,
              })
            : undefined;
          const selectedProviderId = selectedProvider?.id ?? selectedModelRef?.provider;
          const requestKey = buildMediaGenerationRequestKey({
            tool: "music_generate",
            prompt,
            provider: selectedProviderId,
            model:
              model !== undefined
                ? (explicitModelRef?.model ?? model)
                : (primaryModelRef?.model ??
                  musicGenerationModelConfig.primary ??
                  selectedProvider?.defaultModel),
            lyrics,
            instrumental,
            durationSeconds,
            format,
            filename,
            imageInputs,
          });
          const duplicateGuardResult = await createMusicGenerateDuplicateGuardResult(
            options?.agentSessionKey,
            { prompt, requestKey, agentId: options?.requesterAgentId },
          );
          if (duplicateGuardResult) {
            return { kind: "result" as const, result: duplicateGuardResult };
          }
          signal?.throwIfAborted();
          acquired?.assertOpen();
          const remoteMediaSsrfPolicy = resolveRemoteMediaSsrfPolicy(effectiveCfg);
          const loadedReferenceImages = await loadReferenceImages({
            inputs: imageInputs,
            maxBytes: resolveGeneratedMediaMaxBytes(effectiveCfg, "image"),
            workspaceDir: options?.workspaceDir,
            cwd: options?.cwd,
            fsPolicy: options?.fsPolicy,
            sandboxConfig,
            ssrfPolicy: remoteMediaSsrfPolicy,
            signal,
          });
          return {
            kind: "task" as const,
            params: {
              lifecycle: musicGenerationTaskLifecycle,
              sessionKey: options?.agentSessionKey,
              requesterAgentId: options?.requesterAgentId,
              requesterOrigin: options?.requesterOrigin,
              prompt,
              requestKey,
              providerId: selectedProviderId,
              config: effectiveCfg,
              scheduleBackgroundWork,
              onAsyncTaskStarted: options?.onAsyncTaskStarted,
              onFailure: (message: string, meta?: Record<string, unknown>) =>
                log.warn(message, meta),
              messages: [timeout.message],
              detailExtras: {
                ...buildMediaReferenceDetails({
                  entries: loadedReferenceImages,
                  singleKey: "image",
                  pluralKey: "images",
                  getResolvedInput: (entry) => entry.resolvedInput,
                }),
                ...(model ? { model } : {}),
                ...(lyrics ? { requestedLyrics: lyrics } : {}),
                ...(typeof instrumental === "boolean" ? { instrumental } : {}),
                ...(typeof durationSeconds === "number" ? { durationSeconds } : {}),
                ...(format ? { format } : {}),
                ...(filename ? { filename } : {}),
                ...(timeoutMs !== undefined ? { timeoutMs } : {}),
                ...(timeout.normalization
                  ? {
                      requestedTimeoutMs: timeout.normalization.requested,
                      timeoutNormalization: timeout.normalization,
                      warning: timeout.message,
                    }
                  : {}),
              },
              run: (taskHandle: MusicGenerationTaskHandle | null) =>
                executeMusicGenerationJob({
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
                  autoProviderFallback: explicitModelConfig ? false : undefined,
                  timeoutMs,
                  timeoutNormalization: timeout.normalization,
                  providers,
                }),
            },
          };
        },
      });
    },
  };
}
