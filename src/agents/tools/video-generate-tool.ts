import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type, type TSchema } from "typebox";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { parseVideoGenerationModelRef } from "../../media-generation/model-ref.js";
import { resolveGeneratedMediaMaxBytes } from "../../media/configured-max-bytes.js";
import { probeMediaFilesWithinBudget } from "../../media/media-probe.js";
import { saveMediaBuffer } from "../../media/store.js";
import { SaveMediaSourceError } from "../../media/store.shared.js";
import { readSnakeCaseParamRaw } from "../../param-key.js";
import { readBooleanParam } from "../../plugin-sdk/boolean-param.js";
import { normalizePluginsConfig } from "../../plugins/config-state.js";
import { createInstalledPluginEnabledPredicate } from "../../plugins/installed-plugin-index.js";
import { isManifestPluginAvailableForControlPlane } from "../../plugins/manifest-contract-eligibility.js";
import {
  generateVideo,
  listRuntimeVideoGenerationProviders,
} from "../../video-generation/runtime.js";
import type {
  GeneratedVideoAsset,
  VideoGenerationResolution,
  VideoGenerationSourceAsset,
} from "../../video-generation/types.js";
import type { AgentGeneratedAttachment } from "../generated-attachments.js";
import { buildMediaGenerationRequestKey } from "../media-generation-task-status-shared.js";
import { getCustomProviderApiKey } from "../model-auth.js";
import { resolveProviderIdForAuth } from "../provider-auth-aliases.js";
import { ToolInputError, readToolStringParam, type AnyAgentTool } from "./common.js";
import { persistGeneratedMediaBatch } from "./generated-media-batch-persistence.js";
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
import {
  buildMediaGenerateToolExecutionResult,
  buildMediaGenerationDurationDetails,
  buildMediaGenerationGeometryDetails,
  buildSavedMediaAttachment,
} from "./media-generate-result-shared.js";
import { createMediaGenerateExecute } from "./media-generate-tool-actions-shared.js";
import { acquireMediaGenerationToolProviders } from "./media-generation-tool-providers.js";
import {
  buildMediaReferenceDetails,
  createCapabilityProviderRuntimeDeps,
  loadMediaToolReferences,
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

const log = createSubsystemLogger("agents/tools/video-generate");
const MAX_REFERENCE_INPUTS = { image: 9, video: 4, audio: 3 } as const;
const GENERATED_VIDEO_MEDIA_SUBDIR = "tool-video-generation";
const GENERATED_VIDEO_PROBE_BUDGET_MS = 3000;
const GENERATED_VIDEO_PROBE_CONCURRENCY = 2;
const MAX_GENERATED_VIDEO_PROBES = 8;

function normalizeResolution(raw: string | undefined): VideoGenerationResolution | undefined {
  const normalized = raw?.trim();
  if (!normalized) {
    return undefined;
  }
  const uppercase = normalized.toUpperCase();
  if (/^\d+P$/.test(uppercase) || /^\d+K$/.test(uppercase)) {
    return uppercase;
  }
  return normalized;
}

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

function videoReferenceProperties(
  kind: keyof typeof MAX_REFERENCE_INPUTS,
  inputDescription: string,
  rolesDescription: string,
): Record<string, TSchema> {
  const input = kind === "audio" ? "audioRef" : kind;
  return {
    [input]: Type.Optional(Type.String({ description: inputDescription })),
    [`${input}s`]: Type.Optional(
      Type.Array(Type.String(), {
        description: `Reference ${kind}s; max ${MAX_REFERENCE_INPUTS[kind]}.`,
      }),
    ),
    [`${kind}Roles`]: Type.Optional(Type.Array(Type.String(), { description: rolesDescription })),
  };
}

const VideoGenerateToolSchema = Type.Object({
  action: Type.Optional(Type.String({ description: MEDIA_GENERATE_DESCRIPTIONS.action })),
  prompt: Type.Optional(Type.String({ description: "Video prompt." })),
  ...videoReferenceProperties(
    "image",
    "One reference image path/URL.",
    "`image` + `images` roles by index. Values: first_frame, last_frame, reference_image; empty string leaves unset.",
  ),
  ...videoReferenceProperties(
    "video",
    "One reference video path/URL.",
    "`video` + `videos` roles by index. Value: reference_video; empty string leaves unset.",
  ),
  ...videoReferenceProperties(
    "audio",
    "One reference audio path/URL, e.g. music.",
    "`audioRef` + `audioRefs` roles by index. Value: reference_audio; empty string leaves unset.",
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
});
const VideoGenerateWithoutAudioToolSchema = Type.Omit(VideoGenerateToolSchema, [
  "audioRef",
  "audioRefs",
  "audioRoles",
]);

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
  const includeAudioReferences = (() => {
    const agentDir = options?.agentDir;
    const authStore = options?.authProfileStore;
    const authProfileStoreSource = options?.authProfileStoreSource;
    const workspaceDir = options?.workspaceDir;
    const snapshot = loadCapabilityMetadataSnapshot({
      config: cfg,
      workspaceDir,
    });
    const knownProviderIds = new Set<string>();
    const audioCandidateProviderIds = new Set<string>();
    const modelConfig = coerceToolModelConfig(cfg.agents?.defaults?.mediaModels?.video);
    const explicitProviderIds = new Set<string>();
    for (const modelRef of [modelConfig.primary, ...(modelConfig.fallbacks ?? [])]) {
      const parsed = parseVideoGenerationModelRef(modelRef);
      if (parsed?.provider) {
        explicitProviderIds.add(
          resolveProviderIdForAuth(parsed.provider, {
            config: cfg,
            ...(workspaceDir !== undefined ? { workspaceDir } : {}),
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
          config: cfg,
          normalizedConfig: cfg.plugins
            ? (normalizedConfig ??= normalizePluginsConfig(cfg.plugins))
            : undefined,
          isInstalledPluginEnabled: (isInstalledPluginEnabled ??=
            createInstalledPluginEnabledPredicate(snapshot.index.plugins, cfg)),
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
        getCustomProviderApiKey(cfg, providerId) !== undefined ||
        hasSnapshotCapabilityProviderAvailability({
          snapshot,
          key: "videoGenerationProviders",
          providerId,
          config: cfg,
          authStore,
        }) ||
        hasAuthForProvider({
          provider: providerId,
          cfg,
          workspaceDir,
          agentDir,
          authStore,
          authProfileStoreSource,
        })
      ) {
        return true;
      }
    }
    return false;
  })();

  return {
    label: "Video Generation",
    name: "video_generate",
    displaySummary: "Generate videos",
    description:
      "Create video, incl. image-to-video: image refs take first_frame/last_frame/reference_image roles; video refs condition style" +
      (includeAudioReferences ? "; audio refs condition sound" : "") +
      ". resolution up to 4K; audio/watermark toggles. action=list discovers providers/models. Session chat background: call once/request; result returns as a later turn that sends the media. This turn: short ack at most, then end; no poll/yield. status checks active task. Duration may round to provider value.",
    parameters: includeAudioReferences
      ? VideoGenerateToolSchema
      : VideoGenerateWithoutAudioToolSchema,
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
            const loadReferences = async (expectedKind: keyof typeof references) => {
              const { inputs, roles } = references[expectedKind];
              const loaded = await loadMediaToolReferences<VideoGenerationSourceAsset>({
                workspaceReadiness: context.workspaceReadiness,
                inputs,
                toolName: "video_generate",
                expectedKind,
                maxBytes: resolveGeneratedMediaMaxBytes(effectiveCfg, expectedKind),
                workspaceDir: options?.workspaceDir,
                cwd: options?.cwd,
                fsPolicy: options?.fsPolicy,
                sandbox: sandboxConfig,
                ssrfPolicy: remoteMediaSsrfPolicy,
                signal,
                mapMedia: (media) => ({
                  buffer: media.buffer,
                  mimeType: "mimeType" in media ? media.mimeType : media.contentType,
                  fileName: "fileName" in media ? media.fileName : undefined,
                }),
                mapRemote: (url) => ({ url }),
              });
              for (const [index, { source }] of loaded.entries()) {
                const role = roles[index];
                if (role) {
                  source.role = role;
                }
              }
              return loaded;
            };
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
                run: async (taskHandle: MediaGenerationTaskHandle | null) => {
                  videoGenerationTaskLifecycle.recordTaskProgress({
                    handle: taskHandle,
                    progressSummary: "Generating video",
                  });
                  const result = await generateVideo(
                    {
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
                    createCapabilityProviderRuntimeDeps(providers),
                  );
                  videoGenerationTaskLifecycle.recordTaskProgress({
                    handle: taskHandle,
                    progressSummary: "Saving generated video",
                    provider: result.provider,
                    model: result.model,
                  });
                  const remoteAttachment = (url: string, video: GeneratedVideoAsset) =>
                    ({
                      type: "video",
                      url,
                      mimeType: video.mimeType,
                      name: video.fileName,
                    }) satisfies AgentGeneratedAttachment;
                  type PersistedVideo =
                    | ReturnType<typeof buildSavedMediaAttachment<"video">>
                    | ReturnType<typeof remoteAttachment>;
                  // Validate the entire batch before any save starts, retaining provider order.
                  const saves = Array.from(result.videos, (video) => {
                    const buffer = video.buffer;
                    if (!buffer) {
                      if (!video.url) {
                        throw new Error(
                          `Provider ${result.provider} returned a video asset with neither buffer nor url — cannot deliver.`,
                        );
                      }
                      const value = remoteAttachment(video.url, video);
                      return async () => ({ value });
                    }
                    return async () => {
                      try {
                        const savedMedia = await saveMediaBuffer(
                          buffer,
                          video.mimeType,
                          GENERATED_VIDEO_MEDIA_SUBDIR,
                          mediaMaxBytes,
                          filename || video.fileName,
                        );
                        return {
                          value: buildSavedMediaAttachment("video", savedMedia),
                          savedMedia,
                        };
                      } catch (error) {
                        if (
                          video.url &&
                          error instanceof SaveMediaSourceError &&
                          error.code === "too-large"
                        ) {
                          return { value: remoteAttachment(video.url, video) };
                        }
                        throw error;
                      }
                    };
                  });
                  const mediaMaxBytes = resolveGeneratedMediaMaxBytes(effectiveCfg, "video");
                  const deliveredVideos = await persistGeneratedMediaBatch<PersistedVideo>({
                    subdir: GENERATED_VIDEO_MEDIA_SUBDIR,
                    mode: "sequential",
                    saves,
                  });
                  const ignoredOverrides = result.ignoredOverrides ?? [];
                  const ignoredOverrideKeys = new Set(ignoredOverrides.map((entry) => entry.key));
                  const duration = buildMediaGenerationDurationDetails(
                    "video",
                    result,
                    durationSeconds,
                    ignoredOverrideKeys,
                  );
                  const supportedDurationSeconds =
                    result.normalization?.durationSeconds?.supportedValues ??
                    (Array.isArray(result.metadata?.supportedDurationSeconds)
                      ? result.metadata.supportedDurationSeconds.filter(
                          (entry): entry is number =>
                            typeof entry === "number" && Number.isFinite(entry),
                        )
                      : undefined);
                  const geometryDetails = buildMediaGenerationGeometryDetails(
                    "video",
                    result,
                    { size, aspectRatio, resolution },
                    ignoredOverrideKeys,
                  );
                  const allMediaUrls = deliveredVideos.map((video) =>
                    "path" in video ? video.path : video.url,
                  );
                  const savedVideoMetadata = await probeMediaFilesWithinBudget(
                    deliveredVideos.flatMap<
                      Parameters<typeof probeMediaFilesWithinBudget>[0][number]
                    >((video) =>
                      "path" in video ? [{ filePath: video.path, kind: "video" }] : [],
                    ),
                    {
                      budgetMs: GENERATED_VIDEO_PROBE_BUDGET_MS,
                      concurrency: GENERATED_VIDEO_PROBE_CONCURRENCY,
                      maxProbes: MAX_GENERATED_VIDEO_PROBES,
                    },
                  );
                  let savedMetadataIndex = 0;
                  const attachments: AgentGeneratedAttachment[] = deliveredVideos.map((video) =>
                    Object.assign(
                      {
                        ...video,
                        ...(typeof duration.applied === "number"
                          ? { durationMs: duration.applied * 1000 }
                          : {}),
                      },
                      "path" in video ? (savedVideoMetadata[savedMetadataIndex++] ?? {}) : {},
                    ),
                  );
                  const executionResult = await buildMediaGenerateToolExecutionResult({
                    kind: "video",
                    result,
                    attachments,
                    mediaUrls: allMediaUrls,
                    sandbox: context.acquireOutputSandbox,
                    maxBytes: mediaMaxBytes,
                    messages: [duration.message],
                    taskHandle,
                    details: {
                      ...buildMediaReferenceDetails(loadedReferenceImages, "image"),
                      ...buildMediaReferenceDetails(loadedReferenceVideos, "video", {
                        singleRewriteKey: "videoRewrittenFrom",
                      }),
                      ...geometryDetails,
                      ...duration.details,
                      ...(supportedDurationSeconds && supportedDurationSeconds.length > 0
                        ? { supportedDurationSeconds }
                        : {}),
                      ...(!ignoredOverrideKeys.has("audio") && typeof audio === "boolean"
                        ? { audio }
                        : {}),
                      ...(!ignoredOverrideKeys.has("watermark") && typeof watermark === "boolean"
                        ? { watermark }
                        : {}),
                      ...(filename ? { filename } : {}),
                      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
                    },
                  });
                  return {
                    ...executionResult,
                    mediaUrls: allMediaUrls,
                  };
                },
              },
            };
          },
        });
      },
    }),
  };
}
