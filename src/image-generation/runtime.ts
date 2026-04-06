import type { AuthProfileStore } from "../agents/auth-profiles.js";
import { describeFailoverError, isFailoverError } from "../agents/failover-error.js";
import type { FallbackAttempt } from "../agents/model-fallback.types.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildNoCapabilityModelConfiguredMessage,
  deriveAspectRatioFromSize,
  resolveClosestAspectRatio,
  resolveClosestResolution,
  resolveClosestSize,
  resolveCapabilityModelCandidates,
  throwCapabilityGenerationFailure,
} from "../media-generation/runtime-shared.js";
import { parseImageGenerationModelRef } from "./model-ref.js";
import { getImageGenerationProvider, listImageGenerationProviders } from "./provider-registry.js";
import type {
  GeneratedImageAsset,
  ImageGenerationIgnoredOverride,
  ImageGenerationResolution,
  ImageGenerationResult,
  ImageGenerationSourceImage,
} from "./types.js";

const log = createSubsystemLogger("image-generation");

export type GenerateImageParams = {
  cfg: OpenClawConfig;
  prompt: string;
  agentDir?: string;
  authStore?: AuthProfileStore;
  modelOverride?: string;
  count?: number;
  size?: string;
  aspectRatio?: string;
  resolution?: ImageGenerationResolution;
  inputImages?: ImageGenerationSourceImage[];
};

export type GenerateImageRuntimeResult = {
  images: GeneratedImageAsset[];
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
  metadata?: Record<string, unknown>;
  ignoredOverrides: ImageGenerationIgnoredOverride[];
};

function buildNoImageGenerationModelConfiguredMessage(cfg: OpenClawConfig): string {
  return buildNoCapabilityModelConfiguredMessage({
    capabilityLabel: "image-generation",
    modelConfigKey: "imageGenerationModel",
    providers: listImageGenerationProviders(cfg),
  });
}

export function listRuntimeImageGenerationProviders(params?: { config?: OpenClawConfig }) {
  return listImageGenerationProviders(params?.config);
}

function resolveProviderImageGenerationOverrides(params: {
  provider: NonNullable<ReturnType<typeof getImageGenerationProvider>>;
  size?: string;
  aspectRatio?: string;
  resolution?: ImageGenerationResolution;
  inputImages?: ImageGenerationSourceImage[];
}) {
  const hasInputImages = (params.inputImages?.length ?? 0) > 0;
  const modeCaps = hasInputImages
    ? params.provider.capabilities.edit
    : params.provider.capabilities.generate;
  const geometry = params.provider.capabilities.geometry;
  const ignoredOverrides: ImageGenerationIgnoredOverride[] = [];
  let size = params.size;
  let aspectRatio = params.aspectRatio;
  let resolution = params.resolution;

  if (size && (geometry?.sizes?.length ?? 0) > 0 && modeCaps.supportsSize) {
    size = resolveClosestSize({
      requestedSize: size,
      supportedSizes: geometry?.sizes,
    });
  }

  if (!modeCaps.supportsSize && size) {
    let translated = false;
    if (modeCaps.supportsAspectRatio) {
      const normalizedAspectRatio = resolveClosestAspectRatio({
        requestedAspectRatio: aspectRatio,
        requestedSize: size,
        supportedAspectRatios: geometry?.aspectRatios,
      });
      if (normalizedAspectRatio) {
        aspectRatio = normalizedAspectRatio;
        translated = true;
      }
    }
    if (!translated) {
      ignoredOverrides.push({ key: "size", value: size });
    }
    size = undefined;
  }

  if (aspectRatio && (geometry?.aspectRatios?.length ?? 0) > 0 && modeCaps.supportsAspectRatio) {
    aspectRatio = resolveClosestAspectRatio({
      requestedAspectRatio: aspectRatio,
      requestedSize: size,
      supportedAspectRatios: geometry?.aspectRatios,
    });
  } else if (!modeCaps.supportsAspectRatio && aspectRatio) {
    const derivedSize =
      modeCaps.supportsSize && !size
        ? resolveClosestSize({
            requestedSize: params.size,
            requestedAspectRatio: aspectRatio,
            supportedSizes: geometry?.sizes,
          })
        : undefined;
    let translated = false;
    if (derivedSize) {
      size = derivedSize;
      translated = true;
    }
    if (!translated) {
      ignoredOverrides.push({ key: "aspectRatio", value: aspectRatio });
    }
    aspectRatio = undefined;
  }

  if (resolution && (geometry?.resolutions?.length ?? 0) > 0 && modeCaps.supportsResolution) {
    resolution = resolveClosestResolution({
      requestedResolution: resolution,
      supportedResolutions: geometry?.resolutions,
    });
  } else if (!modeCaps.supportsResolution && resolution) {
    ignoredOverrides.push({ key: "resolution", value: resolution });
    resolution = undefined;
  }

  if (size && !modeCaps.supportsSize) {
    ignoredOverrides.push({ key: "size", value: size });
    size = undefined;
  }

  if (aspectRatio && !modeCaps.supportsAspectRatio) {
    ignoredOverrides.push({ key: "aspectRatio", value: aspectRatio });
    aspectRatio = undefined;
  }

  if (resolution && !modeCaps.supportsResolution) {
    ignoredOverrides.push({ key: "resolution", value: resolution });
    resolution = undefined;
  }

  return {
    size,
    aspectRatio,
    resolution,
    ignoredOverrides,
  };
}

export async function generateImage(
  params: GenerateImageParams,
): Promise<GenerateImageRuntimeResult> {
  const candidates = resolveCapabilityModelCandidates({
    cfg: params.cfg,
    modelConfig: params.cfg.agents?.defaults?.imageGenerationModel,
    modelOverride: params.modelOverride,
    parseModelRef: parseImageGenerationModelRef,
    agentDir: params.agentDir,
    listProviders: listImageGenerationProviders,
  });
  if (candidates.length === 0) {
    throw new Error(buildNoImageGenerationModelConfiguredMessage(params.cfg));
  }

  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;

  for (const candidate of candidates) {
    const provider = getImageGenerationProvider(candidate.provider, params.cfg);
    if (!provider) {
      const error = `No image-generation provider registered for ${candidate.provider}`;
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error,
      });
      lastError = new Error(error);
      continue;
    }

    try {
      const sanitized = resolveProviderImageGenerationOverrides({
        provider,
        size: params.size,
        aspectRatio: params.aspectRatio,
        resolution: params.resolution,
        inputImages: params.inputImages,
      });
      const result: ImageGenerationResult = await provider.generateImage({
        provider: candidate.provider,
        model: candidate.model,
        prompt: params.prompt,
        cfg: params.cfg,
        agentDir: params.agentDir,
        authStore: params.authStore,
        count: params.count,
        size: sanitized.size,
        aspectRatio: sanitized.aspectRatio,
        resolution: sanitized.resolution,
        inputImages: params.inputImages,
      });
      if (!Array.isArray(result.images) || result.images.length === 0) {
        throw new Error("Image generation provider returned no images.");
      }
      return {
        images: result.images,
        provider: candidate.provider,
        model: result.model ?? candidate.model,
        attempts,
        metadata: {
          ...result.metadata,
          ...(params.size && sanitized.size && params.size !== sanitized.size
            ? { requestedSize: params.size, normalizedSize: sanitized.size }
            : {}),
          ...((params.aspectRatio &&
            sanitized.aspectRatio &&
            params.aspectRatio !== sanitized.aspectRatio) ||
          (!params.aspectRatio && params.size && sanitized.aspectRatio)
            ? {
                ...(params.size ? { requestedSize: params.size } : {}),
                ...(params.aspectRatio ? { requestedAspectRatio: params.aspectRatio } : {}),
                normalizedAspectRatio: sanitized.aspectRatio,
                ...(params.size
                  ? { aspectRatioDerivedFromSize: deriveAspectRatioFromSize(params.size) }
                  : {}),
              }
            : {}),
          ...(params.resolution &&
          sanitized.resolution &&
          params.resolution !== sanitized.resolution
            ? {
                requestedResolution: params.resolution,
                normalizedResolution: sanitized.resolution,
              }
            : {}),
        },
        ignoredOverrides: sanitized.ignoredOverrides,
      };
    } catch (err) {
      lastError = err;
      const described = isFailoverError(err) ? describeFailoverError(err) : undefined;
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error: described?.message ?? (err instanceof Error ? err.message : String(err)),
        reason: described?.reason,
        status: described?.status,
        code: described?.code,
      });
      log.debug(`image-generation candidate failed: ${candidate.provider}/${candidate.model}`);
    }
  }

  throwCapabilityGenerationFailure({
    capabilityLabel: "image generation",
    attempts,
    lastError,
  });
}
