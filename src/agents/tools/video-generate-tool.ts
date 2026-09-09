/** Runs capability-aware video generation and persistence. */
import { Type, type TSchema } from "typebox";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { parseVideoGenerationModelRef } from "../../media-generation/model-ref.js";
import { resolveGeneratedMediaMaxBytes } from "../../media/configured-max-bytes.js";
import { readSnakeCaseParamRaw } from "../../param-key.js";
import { readBooleanParam } from "../../plugin-sdk/boolean-param.js";
import { isManifestPluginAvailableForControlPlane } from "../../plugins/manifest-contract-eligibility.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { listRuntimeVideoGenerationProviders } from "../../video-generation/runtime.js";
import type { VideoGenerationProvider } from "../../video-generation/types.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { buildMediaGenerationRequestKey } from "../media-generation-task-status-shared.js";
import { getCustomProviderApiKey } from "../model-auth.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.js";
import { resolveProviderIdForAuth } from "../provider-auth-aliases.js";
import { ToolInputError, readNumberParam, readToolStringParam } from "./common.js";
import {
  hasSnapshotCapabilityProviderAvailability,
  loadCapabilityMetadataSnapshot,
} from "./manifest-capability-availability.js";
import {
  createDefaultMediaGenerateBackgroundScheduler,
  type MediaGenerateAsyncStartCallback,
  type MediaGenerateBackgroundScheduler,
} from "./media-generate-background-shared.js";
import {
  runMediaGenerationTask,
  videoGenerationTaskLifecycle,
  type VideoGenerationTaskHandle,
} from "./media-generate-background.js";
import { acquireVideoGenerationToolProviders } from "./media-generation-tool-providers.js";
import {
  applyAgentDefaultModelConfig,
  buildMediaReferenceDetails,
  hasExplicitMediaModel,
  hasGenerationToolAvailability,
  readGenerationTimeoutMs,
  resolveMediaToolSandboxConfig,
  resolveCapabilityModelConfigForTool,
  resolveGenerateAction,
  resolveRemoteMediaSsrfPolicy,
  resolveSelectedCapabilityProvider,
  type MediaToolSandbox,
} from "./media-tool-shared.js";
import {
  hasAuthForProvider,
  coerceToolModelConfig,
  type ToolModelConfig,
} from "./model-config.helpers.js";
import type { AnyAgentTool, ToolFsPolicy } from "./tool-runtime.helpers.js";
import {
  createVideoGenerateDuplicateGuardResult,
  createVideoGenerateListActionResult,
  createVideoGenerateStatusActionResult,
} from "./video-generate-tool.actions.js";
import {
  executeVideoGenerationJob,
  loadReferenceAssets,
  normalizeReferenceInputs,
  normalizeResolution,
  normalizeAspectRatio,
  parseRoleArray,
} from "./video-generate-tool.execution.js";

const log = createSubsystemLogger("agents/tools/video-generate");
const MAX_INPUT_IMAGES = 9;
const MAX_INPUT_VIDEOS = 4;
const MAX_INPUT_AUDIOS = 3;

const VideoGenerateToolProperties = {
  action: Type.Optional(
    Type.String({
      description: '"generate" default, "status" active task, "list" providers/models.',
    }),
  ),
  prompt: Type.Optional(Type.String({ description: "Video prompt." })),
  image: Type.Optional(
    Type.String({
      description: "One reference image path/URL.",
    }),
  ),
  images: Type.Optional(
    Type.Array(Type.String(), {
      description: `Reference images; max ${MAX_INPUT_IMAGES}.`,
    }),
  ),
  imageRoles: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "`image` + `images` roles by index after de-dupe. Values: first_frame, last_frame, reference_image; empty string leaves unset.",
    }),
  ),
  video: Type.Optional(
    Type.String({
      description: "One reference video path/URL.",
    }),
  ),
  videos: Type.Optional(
    Type.Array(Type.String(), {
      description: `Reference videos; max ${MAX_INPUT_VIDEOS}.`,
    }),
  ),
  videoRoles: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "`video` + `videos` roles by index after de-dupe. Value: reference_video; empty string leaves unset.",
    }),
  ),
  audioRef: Type.Optional(
    Type.String({
      description: "One reference audio path/URL, e.g. music.",
    }),
  ),
  audioRefs: Type.Optional(
    Type.Array(Type.String(), {
      description: `Reference audios; max ${MAX_INPUT_AUDIOS}.`,
    }),
  ),
  audioRoles: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "`audioRef` + `audioRefs` roles by index after de-dupe. Value: reference_audio; empty string leaves unset.",
    }),
  ),
  model: Type.Optional(
    Type.String({ description: "Provider/model override, e.g. qwen/wan2.6-t2v." }),
  ),
  filename: Type.Optional(
    Type.String({
      description: "Output filename hint; basename preserved in managed media dir.",
    }),
  ),
  size: Type.Optional(
    Type.String({
      description: "Size hint, e.g. 1280x720, 1920x1080.",
    }),
  ),
  aspectRatio: Type.Optional(
    Type.String({
      description:
        'Aspect ratio: 1:1, 16:9, 9:16, "adaptive", or provider value; unsupported normalized/ignored.',
    }),
  ),
  resolution: Type.Optional(
    Type.String({
      description:
        "Resolution: 360P, 480P, 540P, 720P, 768P, 1080P, 4K, or provider value; unsupported normalized/ignored.",
    }),
  ),
  durationSeconds: Type.Optional(
    Type.Integer({
      description: "Target seconds; may round to nearest supported duration.",
      minimum: 1,
    }),
  ),
  audio: Type.Optional(
    Type.Boolean({
      description: "Generated-audio toggle.",
    }),
  ),
  watermark: Type.Optional(
    Type.Boolean({
      description: "Watermark toggle.",
    }),
  ),
  providerOptions: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        'Provider JSON options, e.g. {"seed":42}. Keys/types must match provider capabilities; mismatch skips candidate. Use action=list for accepted keys.',
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      description: "Provider timeout ms.",
      minimum: 1,
    }),
  ),
} satisfies Record<string, TSchema>;

function createVideoGenerateToolSchema(params: { includeAudioReferences: boolean }) {
  const properties: Record<string, TSchema> = { ...VideoGenerateToolProperties };
  if (!params.includeAudioReferences) {
    delete properties.audioRef;
    delete properties.audioRefs;
    delete properties.audioRoles;
  }
  return Type.Object(properties);
}

function collectVideoGenerationModelProviderIds(params: {
  cfg: OpenClawConfig;
  modelConfig: ToolModelConfig;
  workspaceDir?: string;
}): Set<string> {
  const providerIds = new Set<string>();
  for (const modelRef of [params.modelConfig.primary, ...(params.modelConfig.fallbacks ?? [])]) {
    const parsed = parseVideoGenerationModelRef(modelRef);
    if (parsed?.provider) {
      providerIds.add(
        resolveProviderIdForAuth(parsed.provider, {
          config: params.cfg,
          ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
        }),
      );
    }
  }
  return providerIds;
}

function isVideoGenerationProviderConfigured(params: {
  snapshot: Pick<PluginMetadataSnapshot, "index" | "plugins">;
  cfg: OpenClawConfig;
  workspaceDir?: string;
  agentDir?: string;
  authStore?: AuthProfileStore;
  providerId: string;
}): boolean {
  return (
    getCustomProviderApiKey(params.cfg, params.providerId) !== undefined ||
    hasSnapshotCapabilityProviderAvailability({
      snapshot: params.snapshot,
      key: "videoGenerationProviders",
      providerId: params.providerId,
      config: params.cfg,
      authStore: params.authStore,
    }) ||
    hasAuthForProvider({
      provider: params.providerId,
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      authStore: params.authStore,
    })
  );
}

function shouldExposeVideoReferenceAudioParams(params: {
  cfg: OpenClawConfig;
  agentDir?: string;
  authStore?: AuthProfileStore;
  workspaceDir?: string;
}): boolean {
  const snapshot = loadCapabilityMetadataSnapshot({
    config: params.cfg,
    workspaceDir: params.workspaceDir,
  });
  const knownProviderIds = new Set<string>();
  const audioCandidateProviderIds = new Set<string>();
  const explicitProviderIds = collectVideoGenerationModelProviderIds({
    cfg: params.cfg,
    modelConfig: coerceToolModelConfig(params.cfg.agents?.defaults?.mediaModels?.video),
    ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
  });

  for (const plugin of snapshot.plugins) {
    if (
      !plugin.contracts?.videoGenerationProviders?.length ||
      !isManifestPluginAvailableForControlPlane({
        snapshot,
        plugin,
        config: params.cfg,
      })
    ) {
      continue;
    }
    for (const providerId of plugin.contracts.videoGenerationProviders) {
      knownProviderIds.add(providerId);
      const metadata = plugin.videoGenerationProviderMetadata?.[providerId];
      const providerCanUseReferenceAudio = metadata?.referenceAudioInputs === true;
      for (const alias of metadata?.aliases ?? []) {
        knownProviderIds.add(alias);
        if (providerCanUseReferenceAudio) {
          audioCandidateProviderIds.add(alias);
        }
      }
      if (providerCanUseReferenceAudio) {
        audioCandidateProviderIds.add(providerId);
      }
    }
  }

  for (const providerId of explicitProviderIds) {
    if (!knownProviderIds.has(providerId) || audioCandidateProviderIds.has(providerId)) {
      return true;
    }
  }

  for (const providerId of audioCandidateProviderIds) {
    if (
      isVideoGenerationProviderConfigured({
        snapshot,
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        authStore: params.authStore,
        providerId,
      })
    ) {
      return true;
    }
  }
  return false;
}

function resolveSelectedVideoGenerationProvider(params: {
  config?: OpenClawConfig;
  providers?: VideoGenerationProvider[];
  videoGenerationModelConfig: ToolModelConfig;
  modelOverride?: string;
}): VideoGenerationProvider | undefined {
  return resolveSelectedCapabilityProvider({
    providers: params.providers ?? listRuntimeVideoGenerationProviders({ config: params.config }),
    modelConfig: params.videoGenerationModelConfig,
    modelOverride: params.modelOverride,
    parseModelRef: parseVideoGenerationModelRef,
  });
}

type VideoGenerateSandboxConfig = MediaToolSandbox;

const defaultScheduleVideoGenerateBackgroundWork = createDefaultMediaGenerateBackgroundScheduler({
  toolName: "video_generate",
  onCrash: (message, meta) => log.error(message, meta),
});

export function createVideoGenerateTool(options?: {
  config?: OpenClawConfig;
  agentDir?: string;
  authProfileStore?: AuthProfileStore;
  agentSessionKey?: string;
  requesterAgentId?: string;
  requesterOrigin?: DeliveryContext;
  workspaceDir?: string;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  sandbox?: VideoGenerateSandboxConfig;
  fsPolicy?: ToolFsPolicy;
  scheduleBackgroundWork?: MediaGenerateBackgroundScheduler;
  onAsyncTaskStarted?: MediaGenerateAsyncStartCallback;
}): AnyAgentTool | null {
  const cfg: OpenClawConfig = options?.config ?? getRuntimeConfig();
  const preparedProviders = options?.preparedModelRuntime?.mediaCapabilityProviders
    ?.videoGenerationProviders
    ? [...options.preparedModelRuntime.mediaCapabilityProviders.videoGenerationProviders]
    : undefined;
  if (
    !hasGenerationToolAvailability({
      cfg,
      agentDir: options?.agentDir,
      workspaceDir: options?.workspaceDir,
      authStore: options?.authProfileStore,
      modelConfig: cfg.agents?.defaults?.mediaModels?.video,
      providerKey: "videoGenerationProviders",
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
    options?.scheduleBackgroundWork ?? defaultScheduleVideoGenerateBackgroundWork;
  const includeAudioReferences = shouldExposeVideoReferenceAudioParams({
    cfg,
    agentDir: options?.agentDir,
    authStore: options?.authProfileStore,
    workspaceDir: options?.workspaceDir,
  });

  return {
    label: "Video Generation",
    name: "video_generate",
    displaySummary: "Generate videos",
    description:
      "Create video, incl. image-to-video: image refs take first_frame/last_frame/reference_image roles; video refs condition style" +
      (includeAudioReferences ? "; audio refs condition sound" : "") +
      ". resolution up to 4K; audio/watermark toggles. action=list discovers providers/models. Session chat background: call once/request, await, then visible reply + structured media. status checks active task. Duration may round to provider value.",
    parameters: createVideoGenerateToolSchema({ includeAudioReferences }),
    execute: async (_toolCallId, rawArgs, signal) => {
      const args = rawArgs as Record<string, unknown>;
      const action = resolveGenerateAction(args);

      if (action === "list") {
        return createVideoGenerateListActionResult(cfg, {
          workspaceDir: options?.workspaceDir,
          agentDir: options?.agentDir,
          authStore: options?.authProfileStore,
        });
      }

      if (action === "status") {
        return createVideoGenerateStatusActionResult(
          options?.agentSessionKey,
          options?.requesterAgentId,
        );
      }

      const model = readToolStringParam(args, "model");
      const explicitModelConfig = hasExplicitMediaModel(cfg.agents?.defaults?.mediaModels?.video);
      const configuredModel =
        model || explicitModelConfig
          ? resolveCapabilityModelConfigForTool({
              cfg,
              modelConfig: cfg.agents?.defaults?.mediaModels?.video,
              modelOverride: model,
              providers: [],
            })
          : null;
      const readRequest = () => {
        const prompt = readToolStringParam(args, "prompt", { required: true });
        return {
          prompt,
          duplicate: createVideoGenerateDuplicateGuardResult(options?.agentSessionKey, {
            prompt,
            agentId: options?.requesterAgentId,
          }),
        };
      };
      const configuredRequest = configuredModel ? readRequest() : undefined;
      if (configuredRequest?.duplicate) {
        return configuredRequest.duplicate;
      }
      const acquired = options?.preparedModelRuntime?.acquireMediaCapabilityProviders
        ? await acquireVideoGenerationToolProviders({
            cfg: configuredModel
              ? (applyAgentDefaultModelConfig(cfg, "video", configuredModel) ?? cfg)
              : cfg,
            prepared: options.preparedModelRuntime,
          })
        : undefined;
      const providers = acquired?.providers ?? preparedProviders;
      const prepare = async () => {
        const videoGenerationModelConfig =
          configuredModel ??
          resolveCapabilityModelConfigForTool({
            cfg,
            workspaceDir: options?.workspaceDir,
            agentDir: options?.agentDir,
            authStore: options?.authProfileStore,
            modelConfig: cfg.agents?.defaults?.mediaModels?.video,
            modelOverride: model,
            providers:
              acquired?.providers ?? (() => listRuntimeVideoGenerationProviders({ config: cfg })),
          });
        if (!videoGenerationModelConfig) {
          throw new ToolInputError("No video-generation model configured.");
        }
        const effectiveCfg =
          applyAgentDefaultModelConfig(cfg, "video", videoGenerationModelConfig) ?? cfg;
        const remoteMediaSsrfPolicy = resolveRemoteMediaSsrfPolicy(effectiveCfg);
        const { prompt, duplicate } = configuredRequest ?? readRequest();
        if (duplicate) {
          return { kind: "result" as const, result: duplicate };
        }

        const filename = readToolStringParam(args, "filename");
        const size = readToolStringParam(args, "size");
        const aspectRatio = normalizeAspectRatio(readToolStringParam(args, "aspectRatio"));
        const resolution = normalizeResolution(readToolStringParam(args, "resolution"));
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
        const audio = readBooleanParam(args, "audio");
        const watermark = readBooleanParam(args, "watermark");
        const timeoutMs = readGenerationTimeoutMs(args) ?? videoGenerationModelConfig.timeoutMs;
        // providerOptions must be a plain object. Arrays are objects in JS, so
        // exclude them explicitly — a bogus call like `providerOptions: ["seed", 42]`
        // would otherwise be cast to `Record<string, unknown>` with numeric-string
        // keys and silently forwarded to the provider.
        const providerOptionsRaw = readSnakeCaseParamRaw(args, "providerOptions");
        if (
          providerOptionsRaw != null &&
          (typeof providerOptionsRaw !== "object" || Array.isArray(providerOptionsRaw))
        ) {
          throw new ToolInputError(
            "providerOptions must be a JSON object keyed by provider-specific option name.",
          );
        }
        const providerOptions =
          providerOptionsRaw != null ? (providerOptionsRaw as Record<string, unknown>) : undefined;
        const imageInputs = normalizeReferenceInputs({
          args,
          singularKey: "image",
          pluralKey: "images",
          maxCount: MAX_INPUT_IMAGES,
        });
        // *Roles: parallel string arrays giving each asset a semantic role hint.
        // Use readSnakeCaseParamRaw so both camelCase and snake_case keys are accepted.
        const imageRoles = parseRoleArray({
          raw: readSnakeCaseParamRaw(args, "imageRoles"),
          kind: "imageRoles",
          assetCount: imageInputs.length,
        });
        const videoInputs = normalizeReferenceInputs({
          args,
          singularKey: "video",
          pluralKey: "videos",
          maxCount: MAX_INPUT_VIDEOS,
        });
        const videoRoles = parseRoleArray({
          raw: readSnakeCaseParamRaw(args, "videoRoles"),
          kind: "videoRoles",
          assetCount: videoInputs.length,
        });
        const audioInputs = normalizeReferenceInputs({
          args,
          singularKey: "audioRef",
          pluralKey: "audioRefs",
          maxCount: MAX_INPUT_AUDIOS,
        });
        const audioRoles = parseRoleArray({
          raw: readSnakeCaseParamRaw(args, "audioRoles"),
          kind: "audioRoles",
          assetCount: audioInputs.length,
        });

        const selectedProvider = resolveSelectedVideoGenerationProvider({
          config: effectiveCfg,
          providers,
          videoGenerationModelConfig,
          modelOverride: model,
        });
        const explicitModelRef = parseVideoGenerationModelRef(model);
        const primaryModelRef = parseVideoGenerationModelRef(videoGenerationModelConfig.primary);
        const requestKey = buildMediaGenerationRequestKey({
          tool: "video_generate",
          prompt,
          provider: selectedProvider?.id ?? explicitModelRef?.provider ?? primaryModelRef?.provider,
          model:
            model !== undefined
              ? (explicitModelRef?.model ?? model)
              : (primaryModelRef?.model ??
                videoGenerationModelConfig.primary ??
                selectedProvider?.defaultModel),
          size,
          aspectRatio,
          resolution,
          durationSeconds,
          audio,
          watermark,
          filename,
          providerOptions,
          imageInputs,
          imageRoles,
          videoInputs,
          videoRoles,
          audioInputs,
          audioRoles,
        });
        const duplicateGuardResult = createVideoGenerateDuplicateGuardResult(
          options?.agentSessionKey,
          { prompt, requestKey, agentId: options?.requesterAgentId },
        );
        if (duplicateGuardResult) {
          return { kind: "result" as const, result: duplicateGuardResult };
        }
        const loadedReferenceImages = await loadReferenceAssets({
          inputs: imageInputs,
          expectedKind: "image",
          maxBytes: resolveGeneratedMediaMaxBytes(effectiveCfg, "image"),
          workspaceDir: options?.workspaceDir,
          sandboxConfig,
          ssrfPolicy: remoteMediaSsrfPolicy,
          signal,
        });
        // Attach roles to the loaded image assets (positional, by index into images[]).
        for (let i = 0; i < loadedReferenceImages.length; i++) {
          const role = imageRoles[i];
          const asset = loadedReferenceImages.at(i);
          if (role && asset) {
            asset.sourceAsset.role = role;
          }
        }
        const loadedReferenceVideos = await loadReferenceAssets({
          inputs: videoInputs,
          expectedKind: "video",
          maxBytes: resolveGeneratedMediaMaxBytes(effectiveCfg, "video"),
          workspaceDir: options?.workspaceDir,
          sandboxConfig,
          ssrfPolicy: remoteMediaSsrfPolicy,
          signal,
        });
        for (let i = 0; i < loadedReferenceVideos.length; i++) {
          const role = videoRoles[i];
          const asset = loadedReferenceVideos.at(i);
          if (role && asset) {
            asset.sourceAsset.role = role;
          }
        }
        const loadedReferenceAudios = await loadReferenceAssets({
          inputs: audioInputs,
          expectedKind: "audio",
          maxBytes: resolveGeneratedMediaMaxBytes(effectiveCfg, "audio"),
          workspaceDir: options?.workspaceDir,
          sandboxConfig,
          ssrfPolicy: remoteMediaSsrfPolicy,
          signal,
        });
        for (let i = 0; i < loadedReferenceAudios.length; i++) {
          const role = audioRoles[i];
          const asset = loadedReferenceAudios.at(i);
          if (role && asset) {
            asset.sourceAsset.role = role;
          }
        }
        return {
          kind: "task" as const,
          params: {
            lifecycle: videoGenerationTaskLifecycle,
            generationLabel: "video" as const,
            sessionKey: options?.agentSessionKey,
            requesterAgentId: options?.requesterAgentId,
            requesterOrigin: options?.requesterOrigin,
            prompt,
            requestKey,
            providerId: selectedProvider?.id,
            config: effectiveCfg,
            scheduleBackgroundWork,
            onAsyncTaskStarted: options?.onAsyncTaskStarted,
            onFailure: (message: string, meta?: Record<string, unknown>) => log.warn(message, meta),
            detailExtras: {
              ...buildMediaReferenceDetails({
                entries: loadedReferenceImages,
                singleKey: "image",
                pluralKey: "images",
                getResolvedInput: (entry) => entry.resolvedInput,
              }),
              ...buildMediaReferenceDetails({
                entries: loadedReferenceVideos,
                singleKey: "video",
                pluralKey: "videos",
                getResolvedInput: (entry) => entry.resolvedInput,
                singleRewriteKey: "videoRewrittenFrom",
              }),
              ...(model ? { model } : {}),
              ...(size ? { size } : {}),
              ...(aspectRatio ? { aspectRatio } : {}),
              ...(resolution ? { resolution } : {}),
              ...(typeof durationSeconds === "number" ? { durationSeconds } : {}),
              ...(typeof audio === "boolean" ? { audio } : {}),
              ...(typeof watermark === "boolean" ? { watermark } : {}),
              ...(filename ? { filename } : {}),
              ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            },
            run: (taskHandle: VideoGenerationTaskHandle | null) =>
              executeVideoGenerationJob({
                effectiveCfg,
                prompt,
                agentDir: options?.agentDir,
                model,
                size,
                aspectRatio,
                resolution,
                durationSeconds,
                audio,
                watermark,
                filename,
                loadedReferenceImages,
                loadedReferenceVideos,
                loadedReferenceAudios,
                taskHandle,
                providerOptions,
                autoProviderFallback: explicitModelConfig ? false : undefined,
                timeoutMs,
                providers,
              }),
          },
        };
      };
      let prepared: Awaited<ReturnType<typeof prepare>>;
      try {
        acquired?.assertOpen();
        prepared = acquired ? await acquired.run(prepare) : await prepare();
        if (prepared.kind === "task") {
          // Accepted tasks own paid work independently; cancellation applies before admission.
          signal?.throwIfAborted();
          acquired?.assertOpen();
        }
      } catch (error) {
        let cleanupFailure: { error: unknown } | undefined;
        try {
          await acquired?.release();
        } catch (cleanupError) {
          cleanupFailure = { error: cleanupError };
        }
        if (cleanupFailure) {
          throw new AggregateError(
            [error, cleanupFailure.error],
            "Video preflight and cleanup failed",
            {
              cause: error,
            },
          );
        }
        throw error;
      }
      if (prepared.kind === "result") {
        await acquired?.release();
        return prepared.result;
      }
      return runMediaGenerationTask({ ...prepared.params, resources: acquired });
    },
  };
}
