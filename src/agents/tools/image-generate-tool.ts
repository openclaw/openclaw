/** Runs image generation, persistence, and detached completion. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { Type } from "typebox";
import { findCapabilityProviderById } from "../../../packages/media-generation-core/src/capability-model-ref.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveImageGenerationMaxInputImages } from "../../image-generation/capabilities.js";
import type {
  ImageGenerationOpenAIOptions,
  ImageGenerationProvider,
  ImageGenerationProviderOptions,
  ImageGenerationResolution,
} from "../../image-generation/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { parseImageGenerationModelRef } from "../../media-generation/model-ref.js";
import { withImageGenerationProviders } from "../../media-generation/registry.js";
import { resolveCapabilityModelCandidates } from "../../media-generation/runtime-shared.js";
import { resolveGeneratedMediaMaxBytes } from "../../media/configured-max-bytes.js";
import { readSnakeCaseParamRaw } from "../../param-key.js";
import { createEnumOptionParser } from "../../shared/enum-option.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { buildMediaGenerationRequestKey } from "../media-generation-task-status-shared.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.js";
import { optionalStringEnum } from "../schema/string-enum.js";
import {
  ToolInputError,
  readNonNegativeIntegerParam,
  readPositiveIntegerParam,
  readToolStringParam,
} from "./common.js";
import {
  createImageGenerateDuplicateGuardResult,
  createImageGenerateListActionResult,
  createImageGenerateStatusActionResult,
} from "./image-generate-tool.actions.js";
import {
  executeImageGenerationJob,
  loadImageGenerationReferences,
  inferImageGenerationResolution,
  normalizeImageGenerationAspectRatio,
  normalizeImageGenerationResolution,
} from "./image-generate-tool.execution.js";
import {
  createDefaultMediaGenerateBackgroundScheduler,
  type MediaGenerateAsyncStartCallback,
  type MediaGenerateBackgroundScheduler,
} from "./media-generate-background-shared.js";
import {
  imageGenerationTaskLifecycle,
  runMediaGenerationTask,
  type ImageGenerationTaskHandle,
} from "./media-generate-background.js";
import { acquireImageGenerationToolProviders } from "./media-generation-tool-providers.js";
import {
  applyAgentDefaultModelConfig,
  buildMediaReferenceDetails,
  hasExplicitMediaModel,
  hasGenerationToolAvailability,
  normalizeMediaReferenceInputs,
  readGenerationTimeoutMs,
  resolveMediaToolSandboxConfig,
  resolveRemoteMediaSsrfPolicy,
  resolveCapabilityModelConfigForTool,
  resolveGenerateAction,
  resolveSelectedCapabilityProvider,
  type MediaToolSandbox,
} from "./media-tool-shared.js";
import type { ToolModelConfig } from "./model-config.helpers.js";
import type { AnyAgentTool, ToolFsPolicy } from "./tool-runtime.helpers.js";

const DEFAULT_COUNT = 1;
const MAX_COUNT = 4;
const DEFAULT_MAX_INPUT_IMAGES = 10;
const MAX_REFERENCE_IMAGE_INPUTS = 16;
const SUPPORTED_QUALITIES = ["low", "medium", "high", "xhigh", "max", "auto"] as const;
const SUPPORTED_OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
const SUPPORTED_BACKGROUNDS = ["transparent", "opaque", "auto"] as const;
const SUPPORTED_OPENAI_MODERATIONS = ["low", "auto"] as const;
const SUPPORTED_FAL_CREATIVITY = ["raw", "low", "medium", "high"] as const;

const log = createSubsystemLogger("agents/tools/image-generate");

const ImageGenerateToolSchema = Type.Object({
  action: Type.Optional(
    Type.String({
      description: '"generate" default, "status" active task, "list" providers/models.',
    }),
  ),
  prompt: Type.Optional(Type.String({ description: "Image prompt." })),
  image: Type.Optional(
    Type.String({
      description: "Reference image path/URL for edit.",
    }),
  ),
  images: Type.Optional(
    Type.Array(Type.String(), {
      description: `Reference images for edit or style reference; max ${MAX_REFERENCE_IMAGE_INPUTS}.`,
    }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Provider/model override, e.g. openai/gpt-image-2; transparent OpenAI: openai/gpt-image-1.5.",
    }),
  ),
  filename: Type.Optional(
    Type.String({
      description: "Output filename hint; basename preserved in managed media dir.",
    }),
  ),
  size: Type.Optional(
    Type.String({
      description: "Size hint: 1024x1024, 1536x1024, 1024x1536, 2048x2048, 3840x2160.",
    }),
  ),
  aspectRatio: Type.Optional(
    Type.String({
      description:
        "Aspect ratio: 1:1, 2:1, 20:9, 19.5:9, 2:3, 3:2, 2.35:1, 3:4, 4:3, 4:5, 5:4, 9:16, 9:19.5, 9:20, 16:9, 21:9, 1:2, 4:1, 1:4, 8:1, 1:8.",
    }),
  ),
  resolution: Type.Optional(
    Type.String({
      description: "Resolution: 1K, 2K, 4K; useful for Google.",
    }),
  ),
  quality: optionalStringEnum(SUPPORTED_QUALITIES, {
    description: "Quality: low, medium, high, xhigh, max, auto; model-specific.",
  }),
  outputFormat: optionalStringEnum(SUPPORTED_OUTPUT_FORMATS, {
    description: "Output format: png, jpeg, webp.",
  }),
  background: optionalStringEnum(SUPPORTED_BACKGROUNDS, {
    description: "Background: transparent, opaque, auto. Transparent needs png/webp output.",
  }),
  openai: Type.Optional(
    Type.Object({
      background: optionalStringEnum(SUPPORTED_BACKGROUNDS, {
        description:
          "OpenAI background: transparent, opaque, auto. Transparent needs png/webp; default model routes to gpt-image-1.5.",
      }),
      moderation: optionalStringEnum(SUPPORTED_OPENAI_MODERATIONS, {
        description: "OpenAI moderation: low, auto.",
      }),
      outputCompression: Type.Optional(
        Type.Integer({
          description: "OpenAI jpeg/webp compression 0-100.",
          minimum: 0,
          maximum: 100,
        }),
      ),
      user: Type.Optional(
        Type.String({
          description: "OpenAI stable end-user id.",
        }),
      ),
    }),
  ),
  fal: Type.Optional(
    Type.Object({
      creativity: optionalStringEnum(SUPPORTED_FAL_CREATIVITY, {
        description: "fal Krea creativity: raw, low, medium, high.",
      }),
    }),
  ),
  count: Type.Optional(
    Type.Integer({
      description: `Image count 1-${MAX_COUNT}.`,
      minimum: 1,
      maximum: MAX_COUNT,
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      description: "Provider timeout ms (300000 tends to be a safe amount).",
      minimum: 1,
    }),
  ),
});

function resolveRequestedCount(args: Record<string, unknown>): number {
  if (readSnakeCaseParamRaw(args, "count") === null) {
    throw new ToolInputError(`count must be between 1 and ${MAX_COUNT}`);
  }
  const count = readPositiveIntegerParam(args, "count", {
    message: `count must be between 1 and ${MAX_COUNT}`,
  });
  if (count === undefined) {
    return DEFAULT_COUNT;
  }
  if (count < 1 || count > MAX_COUNT) {
    throw new ToolInputError(`count must be between 1 and ${MAX_COUNT}`);
  }
  return count;
}

const parseImageOption = createEnumOptionParser(ToolInputError);

function readRecordParam(params: Record<string, unknown>, key: string): Record<string, unknown> {
  const raw = params[key];
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function normalizeOpenAIOptions(args: Record<string, unknown>): ImageGenerationOpenAIOptions {
  const raw = readRecordParam(args, "openai");
  const background = parseImageOption(
    readToolStringParam(raw, "background"),
    SUPPORTED_BACKGROUNDS,
    "openai.background",
  );
  const moderation = parseImageOption(
    readToolStringParam(raw, "moderation"),
    SUPPORTED_OPENAI_MODERATIONS,
    "openai.moderation",
  );
  if (readSnakeCaseParamRaw(raw, "outputCompression") === null) {
    throw new ToolInputError("openai.outputCompression must be between 0 and 100");
  }
  const outputCompression = readNonNegativeIntegerParam(raw, "outputCompression", {
    message: "openai.outputCompression must be between 0 and 100",
  });
  const user = readToolStringParam(raw, "user");
  if (outputCompression !== undefined && (outputCompression < 0 || outputCompression > 100)) {
    throw new ToolInputError("openai.outputCompression must be between 0 and 100");
  }
  return {
    ...(background ? { background } : {}),
    ...(moderation ? { moderation } : {}),
    ...(outputCompression !== undefined ? { outputCompression } : {}),
    ...(user ? { user } : {}),
  };
}

function normalizeProviderOptions(
  args: Record<string, unknown>,
): ImageGenerationProviderOptions | undefined {
  const falRaw = readRecordParam(args, "fal");
  const falCreativity = parseImageOption(
    readToolStringParam(falRaw, "creativity"),
    SUPPORTED_FAL_CREATIVITY,
    "fal.creativity",
  );
  const openai = normalizeOpenAIOptions(args);
  const fal = falCreativity ? { creativity: falCreativity } : undefined;
  return fal || Object.keys(openai).length > 0
    ? { ...(fal ? { fal } : {}), ...(Object.keys(openai).length > 0 ? { openai } : {}) }
    : undefined;
}

function normalizeReferenceImages(args: Record<string, unknown>): string[] {
  return normalizeMediaReferenceInputs({
    args,
    singularKey: "image",
    pluralKey: "images",
    maxCount: MAX_REFERENCE_IMAGE_INPUTS,
    label: "reference images",
  });
}

function resolveSelectedImageGenerationProvider(params: {
  providers: ImageGenerationProvider[];
  imageGenerationModelConfig: ToolModelConfig;
  modelOverride?: string;
}): ImageGenerationProvider | undefined {
  return resolveSelectedCapabilityProvider({
    providers: params.providers,
    modelConfig: params.imageGenerationModelConfig,
    modelOverride: params.modelOverride,
    parseModelRef: parseImageGenerationModelRef,
  });
}

function resolveSelectedImageGenerationModelId(params: {
  selectedProvider: ImageGenerationProvider | undefined;
  imageGenerationModelConfig: ToolModelConfig;
  modelOverride?: string;
  explicitModelRef: { provider: string; model: string } | null;
  primaryModelRef: { provider: string; model: string } | null;
}): string | undefined {
  const selectedProviderId = params.selectedProvider?.id;
  const explicitModelRef = params.explicitModelRef;
  const primaryModelRef = params.primaryModelRef;
  if (params.modelOverride !== undefined) {
    if (explicitModelRef && explicitModelRef.provider === selectedProviderId) {
      return explicitModelRef.model;
    }
    if (params.selectedProvider?.models?.includes(params.modelOverride)) {
      return params.modelOverride;
    }
    return explicitModelRef?.model ?? params.modelOverride;
  }
  if (primaryModelRef && primaryModelRef.provider === selectedProviderId) {
    return primaryModelRef.model;
  }
  return params.imageGenerationModelConfig.primary ?? params.selectedProvider?.defaultModel;
}

function resolveReachableImageGenerationMaxInputImages(params: {
  providers: ImageGenerationProvider[];
  candidates: readonly { provider: string; model: string }[];
}): number | undefined {
  const limits = params.candidates.flatMap((candidate) => {
    const provider = findCapabilityProviderById({
      providers: params.providers,
      providerId: candidate.provider,
      normalizeProviderId,
    });
    if (!provider?.capabilities.edit.enabled) {
      return [];
    }
    return [
      resolveImageGenerationMaxInputImages({
        provider,
        model: candidate.model,
      }) ?? DEFAULT_MAX_INPUT_IMAGES,
    ];
  });
  return limits.length > 0 ? Math.max(...limits) : undefined;
}

function modelDisablesImageResolution(
  provider: ImageGenerationProvider | undefined,
  modelId?: string,
) {
  if (!provider || !modelId) {
    return false;
  }
  return provider.capabilities.geometry?.resolutionsByModel?.[modelId]?.length === 0;
}

function validateImageGenerationCapabilities(params: {
  provider: ImageGenerationProvider | undefined;
  count: number;
  inputImageCount: number;
  maxInputImages?: number;
  size?: string;
  aspectRatio?: string;
  resolution?: ImageGenerationResolution;
  explicitResolution?: boolean;
}) {
  const provider = params.provider;
  if (!provider) {
    return;
  }
  const isEdit = params.inputImageCount > 0;
  const modeCaps = isEdit ? provider.capabilities.edit : provider.capabilities.generate;
  const maxCount = modeCaps.maxCount ?? MAX_COUNT;
  if (params.count > maxCount) {
    throw new ToolInputError(
      `${provider.id} ${isEdit ? "edit" : "generate"} supports at most ${maxCount} output image${maxCount === 1 ? "" : "s"}.`,
    );
  }

  if (isEdit) {
    if (!provider.capabilities.edit.enabled) {
      throw new ToolInputError(`${provider.id} does not support reference-image edits.`);
    }
    const maxInputImages =
      params.maxInputImages ??
      provider.capabilities.edit.maxInputImages ??
      DEFAULT_MAX_INPUT_IMAGES;
    if (params.inputImageCount > maxInputImages) {
      throw new ToolInputError(
        `${provider.id} edit supports at most ${maxInputImages} reference image${maxInputImages === 1 ? "" : "s"}.`,
      );
    }
  }
}

type ImageGenerateSandboxConfig = MediaToolSandbox;

const defaultScheduleImageGenerateBackgroundWork = createDefaultMediaGenerateBackgroundScheduler({
  toolName: "image_generate",
  onCrash: (message, meta) => log.error(message, meta),
});

export function createImageGenerateTool(options?: {
  config?: OpenClawConfig;
  agentDir?: string;
  authProfileStore?: AuthProfileStore;
  agentSessionKey?: string;
  requesterAgentId?: string;
  requesterOrigin?: DeliveryContext;
  workspaceDir?: string;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  sandbox?: ImageGenerateSandboxConfig;
  fsPolicy?: ToolFsPolicy;
  scheduleBackgroundWork?: MediaGenerateBackgroundScheduler;
  onAsyncTaskStarted?: MediaGenerateAsyncStartCallback;
}): AnyAgentTool | null {
  const cfg = options?.config ?? getRuntimeConfig();
  const preparedProviders = options?.preparedModelRuntime?.mediaCapabilityProviders
    ?.imageGenerationProviders
    ? [...options.preparedModelRuntime.mediaCapabilityProviders.imageGenerationProviders]
    : undefined;
  if (
    !hasGenerationToolAvailability({
      cfg,
      agentDir: options?.agentDir,
      workspaceDir: options?.workspaceDir,
      authStore: options?.authProfileStore,
      modelConfig: cfg.agents?.defaults?.mediaModels?.image,
      providerKey: "imageGenerationProviders",
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
    options?.scheduleBackgroundWork ?? defaultScheduleImageGenerateBackgroundWork;

  return {
    label: "Image Generation",
    name: "image_generate",
    description:
      'Create/edit images. Batch via count; aspectRatio and resolution up to 4K. Session chat runs background: call once/request, await completion, then visible reply with structured media attachment. Transparent: outputFormat png|webp + background="transparent"; OpenAI also openai.background, default gpt-image-1.5. action=list providers/models/readiness/auth; status active task.',
    parameters: ImageGenerateToolSchema,
    execute: async (_toolCallId, args, signal) => {
      const params = args as Record<string, unknown>;
      const action = resolveGenerateAction(params);
      if (action === "list") {
        return withImageGenerationProviders(cfg, (providers) =>
          createImageGenerateListActionResult({
            cfg,
            providers,
            workspaceDir: options?.workspaceDir,
            agentDir: options?.agentDir,
            authStore: options?.authProfileStore,
          }),
        );
      }
      if (action === "status") {
        return createImageGenerateStatusActionResult(
          options?.agentSessionKey,
          options?.requesterAgentId,
        );
      }

      const model = readToolStringParam(params, "model");
      const explicitModelConfig = hasExplicitMediaModel(cfg.agents?.defaults?.mediaModels?.image);
      const configuredModel =
        model || explicitModelConfig
          ? resolveCapabilityModelConfigForTool({
              cfg,
              modelConfig: cfg.agents?.defaults?.mediaModels?.image,
              modelOverride: model,
              providers: [],
            })
          : null;
      const readRequest = () => {
        const prompt = readToolStringParam(params, "prompt", { required: true });
        return {
          prompt,
          duplicate: createImageGenerateDuplicateGuardResult(options?.agentSessionKey, {
            prompt,
            agentId: options?.requesterAgentId,
          }),
        };
      };
      const configuredRequest = configuredModel ? readRequest() : undefined;
      if (configuredRequest?.duplicate) {
        return configuredRequest.duplicate;
      }
      const acquired = await acquireImageGenerationToolProviders({
        cfg: configuredModel
          ? (applyAgentDefaultModelConfig(cfg, "image", configuredModel) ?? cfg)
          : cfg,
        prepared: options?.preparedModelRuntime,
      });
      const imageGenerationProviders = acquired.providers;
      const prepare = async () => {
        const imageGenerationModelConfig =
          configuredModel ??
          resolveCapabilityModelConfigForTool({
            cfg,
            workspaceDir: options?.workspaceDir,
            agentDir: options?.agentDir,
            authStore: options?.authProfileStore,
            modelConfig: cfg.agents?.defaults?.mediaModels?.image,
            modelOverride: model,
            providers: imageGenerationProviders,
          });
        if (!imageGenerationModelConfig) {
          throw new ToolInputError("No image-generation model configured.");
        }
        const effectiveCfg =
          applyAgentDefaultModelConfig(cfg, "image", imageGenerationModelConfig) ?? cfg;
        const remoteMediaSsrfPolicy = resolveRemoteMediaSsrfPolicy(effectiveCfg);
        const { prompt, duplicate } = configuredRequest ?? readRequest();
        if (duplicate) {
          return { kind: "result" as const, result: duplicate };
        }

        const imageInputs = normalizeReferenceImages(params);
        const filename = readToolStringParam(params, "filename");
        const size = readToolStringParam(params, "size");
        const aspectRatio = normalizeImageGenerationAspectRatio(
          readToolStringParam(params, "aspectRatio"),
        );
        const explicitResolution = normalizeImageGenerationResolution(
          readToolStringParam(params, "resolution"),
        );
        const timeoutMs = readGenerationTimeoutMs(params) ?? imageGenerationModelConfig.timeoutMs;
        const quality = parseImageOption(
          readToolStringParam(params, "quality"),
          SUPPORTED_QUALITIES,
          "quality",
        );
        const outputFormat = parseImageOption(
          readToolStringParam(params, "outputFormat"),
          SUPPORTED_OUTPUT_FORMATS,
          "outputFormat",
        );
        const background = parseImageOption(
          readToolStringParam(params, "background"),
          SUPPORTED_BACKGROUNDS,
          "background",
        );
        const providerOptions = normalizeProviderOptions(params);
        const selectedProvider = resolveSelectedImageGenerationProvider({
          providers: imageGenerationProviders,
          imageGenerationModelConfig,
          modelOverride: model,
        });
        const explicitModelRef = parseImageGenerationModelRef(model);
        const primaryModelRef = parseImageGenerationModelRef(imageGenerationModelConfig.primary);
        const selectedModelId = resolveSelectedImageGenerationModelId({
          selectedProvider,
          imageGenerationModelConfig,
          modelOverride: model,
          explicitModelRef,
          primaryModelRef,
        });
        const imageGenerationCandidates = resolveCapabilityModelCandidates({
          cfg: effectiveCfg,
          modelConfig: effectiveCfg.agents?.defaults?.mediaModels?.image,
          modelOverride: model,
          parseModelRef: parseImageGenerationModelRef,
          agentDir: options?.agentDir,
          listProviders: () => imageGenerationProviders,
          autoProviderFallback: explicitModelConfig ? false : undefined,
        });
        const maxInputImages = resolveReachableImageGenerationMaxInputImages({
          providers: imageGenerationProviders,
          candidates: imageGenerationCandidates,
        });
        const count = resolveRequestedCount(params);
        const requestKey = buildMediaGenerationRequestKey({
          tool: "image_generate",
          prompt,
          provider: selectedProvider?.id ?? explicitModelRef?.provider ?? primaryModelRef?.provider,
          model:
            model !== undefined
              ? (explicitModelRef?.model ?? model)
              : (primaryModelRef?.model ??
                imageGenerationModelConfig.primary ??
                selectedProvider?.defaultModel),
          count,
          imageInputs,
          size,
          aspectRatio,
          resolution: explicitResolution,
          quality,
          outputFormat,
          background,
          filename,
          providerOptions,
        });
        const duplicateGuardResult = createImageGenerateDuplicateGuardResult(
          options?.agentSessionKey,
          { prompt, requestKey, agentId: options?.requesterAgentId },
        );
        if (duplicateGuardResult) {
          return { kind: "result" as const, result: duplicateGuardResult };
        }
        validateImageGenerationCapabilities({
          provider: selectedProvider,
          count,
          inputImageCount: imageInputs.length,
          maxInputImages,
          size,
          aspectRatio,
          resolution: explicitResolution,
          explicitResolution: Boolean(explicitResolution),
        });
        const referenceMaxBytes = resolveGeneratedMediaMaxBytes(effectiveCfg, "image");
        const loadedReferenceImages = await loadImageGenerationReferences({
          imageInputs,
          maxBytes: referenceMaxBytes,
          workspaceDir: options?.workspaceDir,
          sandboxConfig,
          ssrfPolicy: remoteMediaSsrfPolicy,
          signal,
        });
        const inputImages = loadedReferenceImages.map((entry) => entry.sourceImage);
        const modeCaps =
          inputImages.length > 0
            ? selectedProvider?.capabilities.edit
            : selectedProvider?.capabilities.generate;
        const inferredResolution =
          size || explicitResolution
            ? undefined
            : inputImages.length > 0
              ? await inferImageGenerationResolution(inputImages, signal)
              : undefined;
        const resolution =
          explicitResolution ??
          (modeCaps?.supportsResolution === false ||
          modelDisablesImageResolution(selectedProvider, selectedModelId)
            ? undefined
            : inferredResolution);
        validateImageGenerationCapabilities({
          provider: selectedProvider,
          count,
          inputImageCount: inputImages.length,
          maxInputImages,
          size,
          aspectRatio,
          resolution,
          explicitResolution: Boolean(explicitResolution),
        });
        return {
          kind: "task" as const,
          params: {
            lifecycle: imageGenerationTaskLifecycle,
            generationLabel: "image" as const,
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
                getResolvedInput: (entry) => entry.resolvedImage,
              }),
              ...(model ? { model } : {}),
              ...(resolution ? { resolution } : {}),
              ...(size ? { size } : {}),
              ...(aspectRatio ? { aspectRatio } : {}),
              ...(quality ? { quality } : {}),
              ...(outputFormat ? { outputFormat } : {}),
              ...(background ? { background } : {}),
              ...(filename ? { filename } : {}),
              ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            },
            run: (taskHandle: ImageGenerationTaskHandle | null) =>
              executeImageGenerationJob({
                effectiveCfg,
                prompt,
                agentDir: options?.agentDir,
                model,
                size,
                aspectRatio,
                resolution: explicitResolution,
                inferredResolution,
                quality,
                outputFormat,
                background,
                count,
                inputImages,
                timeoutMs,
                providerOptions,
                ssrfPolicy: remoteMediaSsrfPolicy,
                filename,
                loadedReferenceImages,
                taskHandle,
                autoProviderFallback: explicitModelConfig ? false : undefined,
                providers: imageGenerationProviders,
              }),
          },
        };
      };
      let prepared: Awaited<ReturnType<typeof prepare>>;
      try {
        acquired.assertOpen();
        prepared = await acquired.run(prepare);
        if (prepared.kind === "task") {
          // Admission is fenced after preflight; accepted work retains resources independently.
          signal?.throwIfAborted();
          acquired.assertOpen();
        }
      } catch (error) {
        let cleanupFailure: { error: unknown } | undefined;
        try {
          await acquired.release();
        } catch (cleanupError) {
          cleanupFailure = { error: cleanupError };
        }
        if (cleanupFailure) {
          throw new AggregateError(
            [error, cleanupFailure.error],
            "Image preflight and cleanup failed",
            {
              cause: error,
            },
          );
        }
        throw error;
      }
      if (prepared.kind === "result") {
        await acquired.release();
        return prepared.result;
      }
      return runMediaGenerationTask({ ...prepared.params, resources: acquired });
    },
  };
}
