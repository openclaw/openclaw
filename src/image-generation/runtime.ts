import { resolveAgentModelTimeoutMsValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveMediaGeometryOverrides } from "../media-generation/geometry-normalization.js";
import { createMediaProviderLookup } from "../media-generation/provider-registry.js";
import {
  getImageGenerationProvider,
  listImageGenerationProviders,
  withImageGenerationProviders,
} from "../media-generation/registry.js";
import {
  buildMediaGenerationNormalizationMetadata,
  resolveMediaProviderRequestTimeoutMs,
  resolveReferenceImageCapabilityError,
  runMediaGenerationCandidates,
} from "../media-generation/runtime-shared.js";
import { getProviderEnvVarsCore } from "../secrets/provider-env-vars.js";
import type { GenerateImageParams, GenerateImageRuntimeResult } from "./runtime-types.js";
import type { ImageGenerationIgnoredOverride, ImageGenerationResult } from "./types.js";

const log = createSubsystemLogger("image-generation");

/** Dependency seam used by image-generation runtime tests and plugin host callers. */
type ImageGenerationRuntimeDeps = {
  getProvider?: typeof getImageGenerationProvider;
  listProviders?: typeof listImageGenerationProviders;
  getProviderEnvVars?: typeof getProviderEnvVarsCore;
  log?: Pick<typeof log, "warn">;
};

export type { GenerateImageParams, GenerateImageRuntimeResult } from "./runtime-types.js";

/** Lists image-generation providers visible for the current config. */
export function listRuntimeImageGenerationProviders(
  params?: { config?: OpenClawConfig },
  deps: ImageGenerationRuntimeDeps = {},
) {
  return (deps.listProviders ?? listImageGenerationProviders)(params?.config);
}

export async function generateImage(
  params: GenerateImageParams,
  deps: ImageGenerationRuntimeDeps = {},
): Promise<GenerateImageRuntimeResult> {
  if (deps.getProvider && deps.listProviders) {
    return runImageGeneration(params, deps);
  }
  return withImageGenerationProviders(params.cfg, (providers) => {
    const lookup = createMediaProviderLookup(providers);
    return runImageGeneration(params, {
      ...deps,
      getProvider: deps.getProvider ?? lookup.getProvider,
      listProviders: deps.listProviders ?? lookup.listProviders,
    });
  });
}

async function runImageGeneration(
  params: GenerateImageParams,
  deps: ImageGenerationRuntimeDeps,
): Promise<GenerateImageRuntimeResult> {
  const getProvider = deps.getProvider ?? getImageGenerationProvider;
  const listProviders = deps.listProviders ?? listImageGenerationProviders;
  const logger = deps.log ?? log;
  const requestedTimeoutMs =
    params.timeoutMs ??
    resolveAgentModelTimeoutMsValue(params.cfg.agents?.defaults?.mediaModels?.image);

  return runMediaGenerationCandidates({
    request: params,
    listProviders,
    getProviderEnvVars: deps.getProviderEnvVars,
    capability: "image",
    getProvider: (providerId) => getProvider(providerId, params.cfg),
    onFailure: (attempt) => {
      logger.warn(
        `image-generation candidate failed: ${attempt.provider}/${attempt.model}: ${attempt.error}`,
      );
    },
    prepareCandidate(candidate, provider) {
      const inputImageCount = params.inputImages?.length ?? 0;
      const model = candidate.model.trim();
      let prefixLimit: number | undefined;
      let prefixLength = -1;
      if (model) {
        for (const [prefix, limit] of Object.entries(
          provider.capabilities.edit.maxInputImagesByModelPrefix ?? {},
        )) {
          if (prefix.length > prefixLength && model.startsWith(prefix)) {
            prefixLimit = limit;
            prefixLength = prefix.length;
          }
        }
      }
      const maxInputImages =
        (model ? provider.capabilities.edit.maxInputImagesByModel?.[model] : undefined) ??
        prefixLimit ??
        provider.capabilities.edit.maxInputImages;
      const referenceImageError = resolveReferenceImageCapabilityError({
        candidateRef: `${candidate.provider}/${candidate.model}`,
        inputImageCount,
        edit: {
          enabled: provider.capabilities.edit.enabled,
          ...(maxInputImages !== undefined ? { maxInputImages } : {}),
        },
      });
      if (referenceImageError) {
        logger.warn(`image-generation candidate skipped: ${referenceImageError}`);
        return referenceImageError;
      }

      return async (attempts): Promise<GenerateImageRuntimeResult> => {
        const timeoutMs = resolveMediaProviderRequestTimeoutMs({
          timeoutMs: requestedTimeoutMs,
          providerDefaultTimeoutMs: provider.defaultTimeoutMs,
        });
        const modelResolutions =
          provider.capabilities.geometry?.resolutionsByModel?.[candidate.model];
        const modeCapabilities = params.inputImages?.length
          ? provider.capabilities.edit
          : provider.capabilities.generate;
        const inferredResolution =
          modeCapabilities.supportsResolution === false || modelResolutions?.length === 0
            ? undefined
            : params.inferredResolution;
        const geometry = provider.capabilities.geometry;
        const sanitized = resolveMediaGeometryOverrides({
          size: params.size,
          aspectRatio: params.aspectRatio,
          resolution: params.resolution ?? inferredResolution,
          capabilities: {
            ...modeCapabilities,
            sizes: geometry?.sizesByModel?.[candidate.model] ?? geometry?.sizes,
            aspectRatios:
              geometry?.aspectRatiosByModel?.[candidate.model] ?? geometry?.aspectRatios,
            resolutions: modelResolutions ?? geometry?.resolutions,
          },
          fallbackSizes: geometry?.sizes,
        });
        const ignoredOverrides: ImageGenerationIgnoredOverride[] = sanitized.ignoredOverrides;
        let { quality, outputFormat, background } = params;
        const output = provider.capabilities.output;
        const qualities = output?.qualitiesByModel?.[candidate.model] ?? output?.qualities;
        const formats = output?.formatsByModel?.[candidate.model] ?? output?.formats;
        const backgrounds = output?.backgroundsByModel?.[candidate.model] ?? output?.backgrounds;
        if (quality && !(qualities ?? []).includes(quality)) {
          ignoredOverrides.push({ key: "quality", value: quality });
          quality = undefined;
        }
        if (outputFormat && !(formats ?? []).includes(outputFormat)) {
          ignoredOverrides.push({ key: "outputFormat", value: outputFormat });
          outputFormat = undefined;
        }
        if (background && !(backgrounds ?? []).includes(background)) {
          ignoredOverrides.push({ key: "background", value: background });
          background = undefined;
        }
        const normalization = Object.keys(sanitized.normalization).length
          ? sanitized.normalization
          : undefined;
        // Providers receive only supported overrides. Ignored/normalized values
        // are returned to callers so user-facing replies can explain adjustments.
        const result: ImageGenerationResult = await provider.generateImage({
          provider: candidate.provider,
          model: candidate.model,
          prompt: params.prompt,
          cfg: params.cfg,
          agentDir: params.agentDir,
          authStore: params.authStore,
          signal: params.signal,
          count: params.count,
          size: sanitized.size,
          aspectRatio: sanitized.aspectRatio,
          resolution: sanitized.resolution,
          quality,
          outputFormat,
          background,
          inputImages: params.inputImages,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          providerOptions: params.providerOptions,
          ssrfPolicy: params.ssrfPolicy,
        });
        if (!Array.isArray(result.images) || result.images.length === 0) {
          throw new Error("Image generation provider returned no images.");
        }
        const emptyImageIndex = result.images.findIndex((image) => image.buffer.byteLength === 0);
        if (emptyImageIndex >= 0) {
          throw new Error(
            `Image generation provider returned an empty image buffer at index ${emptyImageIndex}.`,
          );
        }
        return {
          images: result.images,
          provider: candidate.provider,
          model: result.model ?? candidate.model,
          attempts,
          ...(sanitized.resolution ? { appliedResolution: sanitized.resolution } : {}),
          normalization,
          metadata: {
            ...result.metadata,
            ...buildMediaGenerationNormalizationMetadata({
              normalization,
              requestedSizeForDerivedAspectRatio: params.size,
            }),
          },
          ignoredOverrides,
        };
      };
    },
  });
}
