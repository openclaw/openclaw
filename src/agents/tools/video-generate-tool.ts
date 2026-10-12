import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type, type TSchema } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { parseVideoGenerationModelRef } from "../../media-generation/model-ref.js";
import { resolveGeneratedMediaMaxBytes } from "../../media/configured-max-bytes.js";
import { readSnakeCaseParamRaw } from "../../param-key.js";
import { readBooleanParam } from "../../plugin-sdk/boolean-param.js";
import { normalizePluginsConfig } from "../../plugins/config-state.js";
import { createInstalledPluginEnabledPredicate } from "../../plugins/installed-plugin-index.js";
import { isManifestPluginAvailableForControlPlane } from "../../plugins/manifest-contract-eligibility.js";
import { listRuntimeVideoGenerationProviders } from "../../video-generation/runtime.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { buildMediaGenerationRequestKey } from "../media-generation-task-status-shared.js";
import { getCustomProviderApiKey } from "../model-auth.js";
import { resolveProviderIdForAuth } from "../provider-auth-aliases.js";
import { ToolInputError, readToolStringParam, type AnyAgentTool } from "./common.js";
import {
  hasSnapshotCapabilityProviderAvailability,
  loadCapabilityMetadataSnapshot,
} from "./manifest-capability-availability.js";
import type { MediaGenerationTaskHandle } from "./media-generate-background-shared.js";
import {
  prepareMediaGenerationTask,
  resolveMediaGenerateToolContext,
  type MediaGenerateToolOptions,
  videoGenerationTaskLifecycle,
} from "./media-generate-background.js";
import { createMediaGenerateExecute } from "./media-generate-tool-actions-shared.js";
import { acquireMediaGenerationToolProviders } from "./media-generation-tool-providers.js";
import {
  buildMediaReferenceDetails,
  MEDIA_GENERATE_DESCRIPTIONS,
  normalizeMediaReferenceInputs,
  readGenerationDurationSeconds,
  readGenerationTimeoutMs,
  resolveSelectedCapabilityProvider,
} from "./media-tool-shared.js";
import { hasAuthForProvider, coerceToolModelConfig } from "./model-config.helpers.js";
import {
  createVideoGenerateDuplicateGuardResult,
  createVideoGenerateListActionResult,
  createVideoGenerateStatusActionResult,
} from "./video-generate-tool.actions.js";
import {
  executeVideoGenerationJob,
  loadReferenceAssets,
  normalizeResolution,
} from "./video-generate-tool.execution.js";

const log = createSubsystemLogger("agents/tools/video-generate");
const MAX_REFERENCE_INPUTS = { image: 9, video: 4, audio: 3 } as const;

function readVideoReferenceInputs(
  args: Record<string, unknown>,
  kind: "image" | "video" | "audio",
) {
  const singularKey = kind === "audio" ? "audioRef" : kind;
  const pluralKey = `${singularKey}s`;
  const roleKey = `${kind}Roles`;
  const inputs = normalizeMediaReferenceInputs({
    args,
    singularKey,
    pluralKey,
    maxCount: MAX_REFERENCE_INPUTS[kind],
    label: `reference ${pluralKey}`,
    dedupe: false,
  });
  const rawRoles = readSnakeCaseParamRaw(args, roleKey);
  if (rawRoles == null) {
    return { inputs, roles: [] };
  }
  if (!Array.isArray(rawRoles)) {
    throw new ToolInputError(
      `${roleKey} must be a JSON array of role strings, parallel to the reference list.`,
    );
  }
  // Empty or non-string slots leave a role unset; extra roles cannot align to an asset.
  const roles = rawRoles.map((entry) => (typeof entry === "string" ? entry.trim() : ""));
  if (roles.length > inputs.length) {
    throw new ToolInputError(
      `${roleKey} has ${roles.length} entries but only ${inputs.length} reference ${kind}${inputs.length === 1 ? "" : "s"} were provided; extra roles cannot be aligned positionally.`,
    );
  }
  return { inputs, roles };
}

const VideoGenerateToolProperties = {
  action: Type.Optional(Type.String({ description: MEDIA_GENERATE_DESCRIPTIONS.action })),
  prompt: Type.Optional(Type.String({ description: "Video prompt." })),
  image: Type.Optional(
    Type.String({
      description: "One reference image path/URL.",
    }),
  ),
  images: Type.Optional(
    Type.Array(Type.String(), {
      description: `Reference images; max ${MAX_REFERENCE_INPUTS.image}.`,
    }),
  ),
  imageRoles: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "`image` + `images` roles by index. Values: first_frame, last_frame, reference_image; empty string leaves unset.",
    }),
  ),
  video: Type.Optional(
    Type.String({
      description: "One reference video path/URL.",
    }),
  ),
  videos: Type.Optional(
    Type.Array(Type.String(), {
      description: `Reference videos; max ${MAX_REFERENCE_INPUTS.video}.`,
    }),
  ),
  videoRoles: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "`video` + `videos` roles by index. Value: reference_video; empty string leaves unset.",
    }),
  ),
  audioRef: Type.Optional(
    Type.String({
      description: "One reference audio path/URL, e.g. music.",
    }),
  ),
  audioRefs: Type.Optional(
    Type.Array(Type.String(), {
      description: `Reference audios; max ${MAX_REFERENCE_INPUTS.audio}.`,
    }),
  ),
  audioRoles: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "`audioRef` + `audioRefs` roles by index. Value: reference_audio; empty string leaves unset.",
    }),
  ),
  model: Type.Optional(
    Type.String({ description: "Provider/model override, e.g. qwen/wan2.6-t2v." }),
  ),
  filename: Type.Optional(Type.String({ description: MEDIA_GENERATE_DESCRIPTIONS.filename })),
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

function shouldExposeVideoReferenceAudioParams(params: {
  cfg: OpenClawConfig;
  agentDir?: string;
  authStore?: AuthProfileStore;
  authProfileStoreSource?: boolean;
  workspaceDir?: string;
}): boolean {
  const snapshot = loadCapabilityMetadataSnapshot({
    config: params.cfg,
    workspaceDir: params.workspaceDir,
  });
  const knownProviderIds = new Set<string>();
  const audioCandidateProviderIds = new Set<string>();
  const modelConfig = coerceToolModelConfig(params.cfg.agents?.defaults?.mediaModels?.video);
  const explicitProviderIds = new Set<string>();
  for (const modelRef of [modelConfig.primary, ...(modelConfig.fallbacks ?? [])]) {
    const parsed = parseVideoGenerationModelRef(modelRef);
    if (parsed?.provider) {
      explicitProviderIds.add(
        resolveProviderIdForAuth(parsed.provider, {
          config: params.cfg,
          ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
        }),
      );
    }
  }
  let normalizedConfig: ReturnType<typeof normalizePluginsConfig> | undefined;
  let isInstalledPluginEnabled:
    | ReturnType<typeof createInstalledPluginEnabledPredicate>
    | undefined;

  for (const plugin of snapshot.plugins) {
    if (
      !plugin.contracts?.videoGenerationProviders?.length ||
      !isManifestPluginAvailableForControlPlane({
        snapshot,
        plugin,
        config: params.cfg,
        normalizedConfig: params.cfg.plugins
          ? (normalizedConfig ??= normalizePluginsConfig(params.cfg.plugins))
          : undefined,
        isInstalledPluginEnabled: (isInstalledPluginEnabled ??=
          createInstalledPluginEnabledPredicate(snapshot.index.plugins, params.cfg)),
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
      getCustomProviderApiKey(params.cfg, providerId) !== undefined ||
      hasSnapshotCapabilityProviderAvailability({
        snapshot,
        key: "videoGenerationProviders",
        providerId,
        config: params.cfg,
        authStore: params.authStore,
      }) ||
      hasAuthForProvider({
        provider: providerId,
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        authStore: params.authStore,
        authProfileStoreSource: params.authProfileStoreSource,
      })
    ) {
      return true;
    }
  }
  return false;
}

export function createVideoGenerateTool(
  options?: MediaGenerateToolOptions,
  preparedAvailability?: boolean,
): AnyAgentTool | null {
  const context = resolveMediaGenerateToolContext(
    "videoGenerationProviders",
    options,
    log,
    preparedAvailability,
  );
  if (!context) {
    return null;
  }
  const { cfg, preparedProviders, sandboxConfig, taskOptions } = context;
  const includeAudioReferences = shouldExposeVideoReferenceAudioParams({
    cfg,
    agentDir: options?.agentDir,
    authStore: options?.authProfileStore,
    authProfileStoreSource: options?.authProfileStoreSource,
    workspaceDir: options?.workspaceDir,
  });
  const properties: Record<string, TSchema> = { ...VideoGenerateToolProperties };
  if (!includeAudioReferences) {
    delete properties.audioRef;
    delete properties.audioRefs;
    delete properties.audioRoles;
  }

  return {
    label: "Video Generation",
    name: "video_generate",
    displaySummary: "Generate videos",
    description:
      "Create video, incl. image-to-video: image refs take first_frame/last_frame/reference_image roles; video refs condition style" +
      (includeAudioReferences ? "; audio refs condition sound" : "") +
      ". resolution up to 4K; audio/watermark toggles. action=list discovers providers/models. Session chat background: call once/request; result returns as a later turn that sends the media. This turn: short ack at most, then end; no poll/yield. status checks active task. Duration may round to provider value.",
    parameters: Type.Object(properties),
    execute: createMediaGenerateExecute({
      options,
      list: (auth) => createVideoGenerateListActionResult(cfg, auth),
      status: createVideoGenerateStatusActionResult,
      generate: (args, signal) => {
        const model = readToolStringParam(args, "model");
        return prepareMediaGenerationTask({
          generationLabel: "video",
          cfg,
          args,
          model,
          options,
          signal,
          findDuplicate: createVideoGenerateDuplicateGuardResult,
          acquire: async (config) =>
            options?.preparedModelRuntime?.acquireMediaCapabilityProviders
              ? acquireMediaGenerationToolProviders("videoGenerationProviders", {
                  cfg: config,
                  prepared: options.preparedModelRuntime,
                })
              : undefined,
          resolveProviders: (acquired) =>
            acquired?.providers ?? (() => listRuntimeVideoGenerationProviders({ config: cfg })),
          prepare: async ({
            resources: acquired,
            modelConfig: videoGenerationModelConfig,
            effectiveCfg,
            prompt,
            explicitModelConfig,
          }) => {
            const providers = acquired?.providers ?? preparedProviders;
            const remoteMediaSsrfPolicy = effectiveCfg.tools?.web?.fetch?.ssrfPolicy;

            const filename = readToolStringParam(args, "filename");
            const size = readToolStringParam(args, "size");
            const aspectRatio = readToolStringParam(args, "aspectRatio");
            const resolution = normalizeResolution(readToolStringParam(args, "resolution"));
            const durationSeconds = readGenerationDurationSeconds(args);
            const audio = readBooleanParam(args, "audio");
            const watermark = readBooleanParam(args, "watermark");
            const timeoutMs = readGenerationTimeoutMs(args) ?? videoGenerationModelConfig.timeoutMs;
            const providerOptions = readSnakeCaseParamRaw(args, "providerOptions") ?? undefined;
            if (providerOptions !== undefined && !isRecord(providerOptions)) {
              throw new ToolInputError(
                "providerOptions must be a JSON object keyed by provider-specific option name.",
              );
            }
            const references = {
              image: readVideoReferenceInputs(args, "image"),
              video: readVideoReferenceInputs(args, "video"),
              audio: readVideoReferenceInputs(args, "audio"),
            };

            const selectedProvider = resolveSelectedCapabilityProvider({
              providers: providers ?? listRuntimeVideoGenerationProviders({ config: effectiveCfg }),
              modelConfig: videoGenerationModelConfig,
              modelOverride: model,
            });
            const explicitModelRef = parseVideoGenerationModelRef(model);
            const primaryModelRef = parseVideoGenerationModelRef(
              videoGenerationModelConfig.primary,
            );
            const requestKey = buildMediaGenerationRequestKey({
              tool: "video_generate",
              prompt,
              provider:
                selectedProvider?.id ?? explicitModelRef?.provider ?? primaryModelRef?.provider,
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
              imageInputs: references.image.inputs,
              imageRoles: references.image.roles,
              videoInputs: references.video.inputs,
              videoRoles: references.video.roles,
              audioInputs: references.audio.inputs,
              audioRoles: references.audio.roles,
            });
            const duplicateGuardResult = await createVideoGenerateDuplicateGuardResult(
              options?.agentSessionKey,
              { prompt, requestKey, agentId: options?.requesterAgentId },
            );
            if (duplicateGuardResult) {
              return { kind: "result" as const, result: duplicateGuardResult };
            }
            signal?.throwIfAborted();
            acquired?.assertOpen();
            const loadReferences = (expectedKind: keyof typeof references) =>
              loadReferenceAssets({
                ...references[expectedKind],
                expectedKind,
                maxBytes: resolveGeneratedMediaMaxBytes(effectiveCfg, expectedKind),
                workspaceDir: options?.workspaceDir,
                cwd: options?.cwd,
                fsPolicy: options?.fsPolicy,
                sandboxConfig,
                ssrfPolicy: remoteMediaSsrfPolicy,
                signal,
              });
            const loadedReferenceImages = await loadReferences("image");
            const loadedReferenceVideos = await loadReferences("video");
            const loadedReferenceAudios = await loadReferences("audio");
            return {
              kind: "task" as const,
              params: {
                lifecycle: videoGenerationTaskLifecycle,
                ...taskOptions(),
                prompt,
                requestKey,
                providerId: selectedProvider?.id,

                detailExtras: {
                  ...buildMediaReferenceDetails(loadedReferenceImages, "image"),
                  ...buildMediaReferenceDetails(loadedReferenceVideos, "video", {
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
                run: (taskHandle: MediaGenerationTaskHandle | null) =>
                  executeVideoGenerationJob({
                    request: {
                      cfg: effectiveCfg,
                      prompt,
                      agentDir: options?.agentDir,
                      modelOverride: model,
                      size,
                      aspectRatio,
                      resolution,
                      durationSeconds,
                      audio,
                      watermark,
                      inputImages: loadedReferenceImages.map((entry) => entry.source),
                      inputVideos: loadedReferenceVideos.map((entry) => entry.source),
                      inputAudios: loadedReferenceAudios.map((entry) => entry.source),
                      autoProviderFallback: explicitModelConfig ? false : undefined,
                      providerOptions,
                      timeoutMs,
                    },
                    filename,
                    loadedReferenceImages,
                    loadedReferenceVideos,
                    taskHandle,
                    providers,
                  }),
              },
            };
          },
        });
      },
    }),
  };
}
