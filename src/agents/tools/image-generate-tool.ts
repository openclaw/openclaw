import { extnameFromAnyPath } from "@openclaw/media-core/file-name";
import { extensionForMime } from "@openclaw/media-core/mime";
import { Type } from "typebox";
import { normalizeImageGenerationResolution } from "../../image-generation/resolution.js";
import { generateImage } from "../../image-generation/runtime.js";
import type {
  ImageGenerationOpenAIOptions,
  ImageGenerationProviderOptions,
  ImageGenerationResolution,
  ImageGenerationSourceImage,
} from "../../image-generation/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { parseImageGenerationModelRef } from "../../media-generation/model-ref.js";
import { withImageGenerationProviders } from "../../media-generation/registry.js";
import { resolveGeneratedMediaMaxBytes } from "../../media/configured-max-bytes.js";
import { encodeImageWithinBytes, getImageMetadata } from "../../media/media-services.js";
import { formatMediaSize } from "../../media/store.shared.js";
import { readSnakeCaseParamRaw } from "../../param-key.js";
import { createEnumOptionParser } from "../../shared/enum-option.js";
import { buildMediaGenerationRequestKey } from "../media-generation-task-status-shared.js";
import { optionalStringEnum } from "../schema/string-enum.js";
import {
  asToolParamsRecord,
  ToolInputError,
  readNonNegativeIntegerParam,
  readPositiveIntegerParam,
  readToolStringParam,
  type AnyAgentTool,
} from "./common.js";
import { persistGeneratedMediaBuffers } from "./generated-media-batch-persistence.js";
import {
  createImageGenerateDuplicateGuardResult,
  createImageGenerateListActionResult,
  createImageGenerateStatusActionResult,
} from "./image-generate-tool.actions.js";
import type { MediaGenerationTaskHandle } from "./media-generate-background-shared.js";
import {
  imageGenerationTaskLifecycle,
  prepareMediaGenerationTask,
  resolveMediaGenerateToolContext,
  type MediaGenerateToolOptions,
} from "./media-generate-background.js";
import {
  buildMediaGenerateToolExecutionResult,
  buildSavedMediaAttachment,
  buildMediaGenerationGeometryDetails,
} from "./media-generate-result-shared.js";
import { createMediaGenerateExecute } from "./media-generate-tool-actions-shared.js";
import { acquireMediaGenerationToolProviders } from "./media-generation-tool-providers.js";
import {
  buildMediaReferenceDetails,
  createCapabilityProviderRuntimeDeps,
  MEDIA_GENERATE_DESCRIPTIONS,
  loadMediaToolReferences,
  normalizeMediaReferenceInputs,
  readGenerationTimeoutMs,
  resolveSelectedCapabilityProvider,
} from "./media-tool-shared.js";

const DEFAULT_COUNT = 1;
const MAX_COUNT = 4;
const MAX_REFERENCE_IMAGE_INPUTS = 16;
const DEFAULT_RESOLUTION: ImageGenerationResolution = "1K";
const GENERATED_IMAGE_MEDIA_SUBDIR = "tool-image-generation";
const SUPPORTED_QUALITIES = ["low", "medium", "high", "xhigh", "max", "auto"] as const;
const SUPPORTED_OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
const SUPPORTED_BACKGROUNDS = ["transparent", "opaque", "auto"] as const;
const SUPPORTED_OPENAI_MODERATIONS = ["low", "auto"] as const;
const SUPPORTED_FAL_CREATIVITY = ["raw", "low", "medium", "high"] as const;
const SUPPORTED_ASPECT_RATIOS = [
  "1:1",
  "2:1",
  "20:9",
  "19.5:9",
  "2:3",
  "3:2",
  "2.35:1",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "9:19.5",
  "9:20",
  "16:9",
  "21:9",
  "1:2",
  "4:1",
  "1:4",
  "8:1",
  "1:8",
] as const;

const log = createSubsystemLogger("agents/tools/image-generate");

const ImageGenerateToolSchema = Type.Object({
  action: Type.Optional(Type.String({ description: MEDIA_GENERATE_DESCRIPTIONS.action })),
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
  filename: Type.Optional(Type.String({ description: MEDIA_GENERATE_DESCRIPTIONS.filename })),
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

const parseImageOption = createEnumOptionParser(ToolInputError);

/**
 * Re-encodes provider images that exceed the media store cap so a paid generation is kept.
 * Fails only when no encoding fits, naming the generated image, its size and the cap.
 */
async function fitGeneratedImagesToMaxBytes<
  T extends { buffer: Buffer; mimeType: string; fileName?: string },
>(images: readonly T[], maxBytes: number): Promise<{ images: T[]; messages: string[] }> {
  const fitted: T[] = [];
  const messages: string[] = [];
  const limit = formatMediaSize(maxBytes);
  for (const [index, image] of images.entries()) {
    if (image.buffer.byteLength <= maxBytes) {
      fitted.push(image);
      continue;
    }
    const label = `Generated image ${index + 1} (${image.mimeType}, ${formatMediaSize(image.buffer.byteLength)})`;
    let encoded: Awaited<ReturnType<typeof encodeImageWithinBytes>>;
    try {
      encoded = await encodeImageWithinBytes(image.buffer, maxBytes);
    } catch (error) {
      throw new Error(`${label} exceeds the ${limit} media limit and could not be re-encoded`, {
        cause: error,
      });
    }
    if (encoded.bytes > maxBytes) {
      throw new Error(
        `${label} exceeds the ${limit} media limit; the smallest re-encoding is ${formatMediaSize(encoded.bytes)} (${encoded.mimeType}, ${encoded.width}x${encoded.height})`,
      );
    }
    const fileName =
      image.fileName &&
      `${image.fileName.slice(0, image.fileName.length - extnameFromAnyPath(image.fileName).length)}${extensionForMime(encoded.mimeType) ?? ""}`;
    fitted.push({
      ...image,
      buffer: encoded.data,
      mimeType: encoded.mimeType,
      ...(fileName ? { fileName } : {}),
    });
    messages.push(
      `${label} exceeded the ${limit} media limit; saved as ${encoded.mimeType}, ${formatMediaSize(encoded.bytes)}, ${encoded.width}x${encoded.height}.`,
    );
  }
  return { images: fitted, messages };
}

async function inferImageGenerationResolution(
  images: ImageGenerationSourceImage[],
  signal?: AbortSignal,
): Promise<ImageGenerationResolution> {
  let maxDimension = 0;
  for (const image of images) {
    signal?.throwIfAborted();
    const meta = await getImageMetadata(image.buffer);
    signal?.throwIfAborted();
    const dimension = Math.max(meta?.width ?? 0, meta?.height ?? 0);
    maxDimension = Math.max(maxDimension, dimension);
  }
  if (maxDimension >= 3000) {
    return "4K";
  }
  if (maxDimension >= 1500) {
    return "2K";
  }
  return DEFAULT_RESOLUTION;
}

function normalizeOpenAIOptions(args: Record<string, unknown>): ImageGenerationOpenAIOptions {
  const raw = asToolParamsRecord(args.openai);
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
    max: 100,
  });
  const user = readToolStringParam(raw, "user");
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
  const falRaw = asToolParamsRecord(args.fal);
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

export function createImageGenerateTool(
  options?: MediaGenerateToolOptions,
  preparedAvailability?: boolean,
): AnyAgentTool | null {
  const context = resolveMediaGenerateToolContext(
    "imageGenerationProviders",
    options,
    log,
    preparedAvailability,
  );
  if (!context) {
    return null;
  }
  const { cfg, sandboxConfig, taskOptions } = context;

  return {
    label: "Image Generation",
    name: "image_generate",
    description:
      'Create/edit images. Batch via count; aspectRatio and resolution up to 4K. Session chat runs in background: call once/request; the result returns as a later turn that sends the media. This turn: short ack at most, then end; no poll/yield. Transparent: outputFormat png|webp + background="transparent"; OpenAI also openai.background, default gpt-image-1.5. action=list providers/models/readiness/auth; status active task.',
    parameters: ImageGenerateToolSchema,
    execute: createMediaGenerateExecute({
      options,
      list: (auth) =>
        withImageGenerationProviders(cfg, (providers) =>
          createImageGenerateListActionResult({ cfg, providers, ...auth }),
        ),
      status: createImageGenerateStatusActionResult,
      generate: (params, signal) => {
        const model = readToolStringParam(params, "model");
        return prepareMediaGenerationTask({
          generationLabel: "image",
          cfg,
          args: params,
          model,
          options,
          signal,
          findDuplicate: createImageGenerateDuplicateGuardResult,
          acquire: (config) =>
            acquireMediaGenerationToolProviders("imageGenerationProviders", {
              cfg: config,
              prepared: options?.preparedModelRuntime,
            }),
          resolveProviders: (acquired) => acquired.providers,
          prepare: async ({
            resources: acquired,
            modelConfig: imageGenerationModelConfig,
            effectiveCfg,
            prompt,
            explicitModelConfig,
          }) => {
            const imageGenerationProviders = acquired.providers;
            const remoteMediaSsrfPolicy = effectiveCfg.tools?.web?.fetch?.ssrfPolicy;

            const imageInputs = normalizeMediaReferenceInputs({
              args: params,
              singularKey: "image",
              pluralKey: "images",
              maxCount: MAX_REFERENCE_IMAGE_INPUTS,
              label: "reference images",
            });
            const filename = readToolStringParam(params, "filename");
            const size = readToolStringParam(params, "size");
            const aspectRatio = parseImageOption(
              readToolStringParam(params, "aspectRatio"),
              SUPPORTED_ASPECT_RATIOS,
              "aspectRatio",
            );
            const explicitResolution = normalizeImageGenerationResolution(
              readToolStringParam(params, "resolution"),
            );
            const timeoutMs =
              readGenerationTimeoutMs(params) ?? imageGenerationModelConfig.timeoutMs;
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
            const selectedProvider = resolveSelectedCapabilityProvider({
              providers: imageGenerationProviders,
              modelConfig: imageGenerationModelConfig,
              modelOverride: model,
            });
            const explicitModelRef = parseImageGenerationModelRef(model);
            const primaryModelRef = parseImageGenerationModelRef(
              imageGenerationModelConfig.primary,
            );
            const selectedProviderId = selectedProvider?.id;
            const selectedModelId =
              model !== undefined
                ? explicitModelRef && explicitModelRef.provider === selectedProviderId
                  ? explicitModelRef.model
                  : selectedProvider?.models?.includes(model)
                    ? model
                    : (explicitModelRef?.model ?? model)
                : primaryModelRef && primaryModelRef.provider === selectedProviderId
                  ? primaryModelRef.model
                  : (imageGenerationModelConfig.primary ?? selectedProvider?.defaultModel);
            if (readSnakeCaseParamRaw(params, "count") === null) {
              throw new ToolInputError(`count must be between 1 and ${MAX_COUNT}`);
            }
            const count =
              readPositiveIntegerParam(params, "count", {
                message: `count must be between 1 and ${MAX_COUNT}`,
                max: MAX_COUNT,
              }) ?? DEFAULT_COUNT;
            const requestKey = buildMediaGenerationRequestKey({
              tool: "image_generate",
              prompt,
              provider:
                selectedProvider?.id ?? explicitModelRef?.provider ?? primaryModelRef?.provider,
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
            const duplicateGuardResult = await createImageGenerateDuplicateGuardResult(
              options?.agentSessionKey,
              { prompt, requestKey, agentId: options?.requesterAgentId },
            );
            if (duplicateGuardResult) {
              return { kind: "result" as const, result: duplicateGuardResult };
            }
            signal?.throwIfAborted();
            acquired.assertOpen();
            if (selectedProvider) {
              const isEdit = imageInputs.length > 0;
              const modeCaps = isEdit
                ? selectedProvider.capabilities.edit
                : selectedProvider.capabilities.generate;
              const maxCount = modeCaps.maxCount ?? MAX_COUNT;
              if (count > maxCount) {
                throw new ToolInputError(
                  `${selectedProvider.id} ${isEdit ? "edit" : "generate"} supports at most ${maxCount} output image${maxCount === 1 ? "" : "s"}.`,
                );
              }
            }
            const referenceMaxBytes = resolveGeneratedMediaMaxBytes(effectiveCfg, "image");
            const loadedReferenceImages = await loadMediaToolReferences({
              workspaceReadiness: context.workspaceReadiness,
              inputs: imageInputs,
              toolName: "image_generate",
              expectedKind: "image",
              maxBytes: referenceMaxBytes,
              workspaceDir: options?.workspaceDir,
              cwd: options?.cwd,
              fsPolicy: options?.fsPolicy,
              sandbox: sandboxConfig,
              ssrfPolicy: remoteMediaSsrfPolicy,
              signal,
              mapMedia: (media) => ({
                buffer: media.buffer,
                mimeType:
                  ("contentType" in media && media.contentType) ||
                  ("mimeType" in media && media.mimeType) ||
                  "image/png",
              }),
            });
            const inputImages = loadedReferenceImages.map((entry) => entry.source);
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
              (selectedModelId &&
                selectedProvider?.capabilities.geometry?.resolutionsByModel?.[selectedModelId]
                  ?.length === 0)
                ? undefined
                : inferredResolution);
            return {
              kind: "task" as const,
              params: {
                lifecycle: imageGenerationTaskLifecycle,
                ...taskOptions(),
                prompt,
                requestKey,
                providerId: selectedProvider?.id,

                detailExtras: {
                  ...buildMediaReferenceDetails(loadedReferenceImages, "image"),
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
                run: async (taskHandle: MediaGenerationTaskHandle | null) => {
                  imageGenerationTaskLifecycle.recordTaskProgress({
                    handle: taskHandle,
                    progressSummary: "Generating image",
                  });
                  const result = await generateImage(
                    {
                      cfg: effectiveCfg,
                      prompt,
                      agentDir: options?.agentDir,
                      modelOverride: model,
                      autoProviderFallback: explicitModelConfig ? false : undefined,
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
                    },
                    createCapabilityProviderRuntimeDeps(imageGenerationProviders),
                  );
                  imageGenerationTaskLifecycle.recordTaskProgress({
                    handle: taskHandle,
                    progressSummary: "Saving generated image",
                  });
                  const geometryDetails = buildMediaGenerationGeometryDetails("image", result, {
                    size,
                    aspectRatio,
                  });
                  const maxBytes = resolveGeneratedMediaMaxBytes(effectiveCfg, "image");
                  const fitted = await fitGeneratedImagesToMaxBytes(
                    result.images.map((image) => ({
                      ...image,
                      fileName: filename || image.fileName,
                    })),
                    maxBytes,
                  );
                  const savedImages = await persistGeneratedMediaBuffers({
                    assets: fitted.images,
                    subdir: GENERATED_IMAGE_MEDIA_SUBDIR,
                    maxBytes,
                  });
                  const revisedPrompts = result.images
                    .map((image) => image.revisedPrompt?.trim())
                    .filter((entry): entry is string => Boolean(entry));
                  const attachments = savedImages.map((image) =>
                    buildSavedMediaAttachment("image", image),
                  );
                  const execution = await buildMediaGenerateToolExecutionResult({
                    kind: "image",
                    result,
                    attachments,
                    mediaUrls: savedImages.map((media) => media.path),
                    sandbox: context.acquireOutputSandbox,
                    maxBytes,
                    messages: fitted.messages,
                    taskHandle,
                    details: {
                      ...buildMediaReferenceDetails(loadedReferenceImages, "image"),
                      ...geometryDetails,
                      ...(quality ? { quality } : {}),
                      ...(outputFormat ? { outputFormat } : {}),
                      ...(background ? { background } : {}),
                      ...(filename ? { filename } : {}),
                      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
                    },
                  });
                  if (revisedPrompts.length > 0) {
                    execution.details.revisedPrompts = revisedPrompts;
                  }
                  return execution;
                },
              },
            };
          },
        });
      },
    }),
  };
}
