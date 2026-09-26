// Video capability overlays merge config overrides into provider capabilities.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveVideoGenerationModeCapabilities } from "./capabilities.js";
import type { GenerateVideoParams } from "./runtime-types.js";
import type {
  VideoGenerationModeCapabilities,
  VideoGenerationProvider,
  VideoGenerationProviderCapabilities,
  VideoGenerationTransformCapabilities,
} from "./types.js";

// Runtime/model capability overlays let a provider refine static manifest caps
// for the selected model without rebuilding the registry.
function isVideoGenerationTransformCapabilities(
  capabilities: VideoGenerationModeCapabilities | VideoGenerationTransformCapabilities | undefined,
): capabilities is VideoGenerationTransformCapabilities {
  return Boolean(capabilities && "enabled" in capabilities);
}

export function buildVideoGenerationCapabilityFailure(params: {
  providerId: string;
  model: string;
  provider: VideoGenerationProvider;
  inputImageCount: number;
  inputVideoCount: number;
  inputAudioCount: number;
}): string | undefined {
  const { providerId, model, provider, inputImageCount, inputVideoCount, inputAudioCount } = params;
  const label = `${providerId}/${model}`;
  const { mode, capabilities } = resolveVideoGenerationModeCapabilities({
    provider,
    model,
    inputImageCount,
    inputVideoCount,
  });
  const catalogModes = provider.catalogByModel?.[model]?.modes;
  if (mode && catalogModes && !catalogModes.includes(mode)) {
    const modeLabel =
      mode === "generate"
        ? "text-to-video generation"
        : mode === "imageToVideo"
          ? "image-to-video generation"
          : "video-to-video generation";
    return `${label} does not support ${modeLabel}; skipping`;
  }

  if (inputImageCount > 0 || inputVideoCount > 0) {
    // Reference inputs must be explicitly supported. Falling back to a provider
    // that ignores them would look successful while losing user-supplied assets.
    const visualLabel =
      inputImageCount > 0 && inputVideoCount > 0
        ? "combined image/video reference inputs"
        : inputImageCount > 0
          ? "reference image inputs"
          : "reference video inputs";
    if (!capabilities || !isVideoGenerationTransformCapabilities(capabilities)) {
      return `${label} does not support ${visualLabel}; skipping to avoid silent reference drop`;
    }
    if (!capabilities.enabled) {
      return `${label} does not support ${visualLabel}; skipping to avoid silent reference drop`;
    }
  }

  // Keep image, video, then audio precedence and resolve only requested limits.
  for (const [count, limitKey, kind] of [
    [inputImageCount, "maxInputImages", "image"],
    [inputVideoCount, "maxInputVideos", "video"],
    [inputAudioCount, "maxInputAudios", "audio"],
  ] as const) {
    if (count > 0) {
      const maximum = capabilities?.[limitKey] ?? provider.capabilities[limitKey] ?? 0;
      if (count > maximum) {
        return maximum === 0
          ? `${label} does not support reference ${kind} inputs; skipping to avoid silent ${kind} drop`
          : `${label} supports at most ${maximum} reference ${kind}(s), ${count} requested; skipping`;
      }
    }
  }

  return undefined;
}

function mergeVideoGenerationCapabilities<T extends VideoGenerationModeCapabilities>(
  base: T,
  overlay: T,
): T {
  const overlayOptions = overlay.providerOptions;
  // Explicit empty providerOptions means "clear inherited options"; undefined
  // means "inherit base declaration".
  const mergedProviderOptions =
    Object.hasOwn(overlay, "providerOptions") &&
    overlayOptions &&
    Object.keys(overlayOptions).length === 0
      ? overlayOptions
      : base.providerOptions || overlayOptions
        ? {
            ...base.providerOptions,
            ...overlayOptions,
          }
        : undefined;
  return {
    ...base,
    ...overlay,
    ...(mergedProviderOptions ? { providerOptions: mergedProviderOptions } : {}),
  } as T;
}

function mergeVideoGenerationModeCapabilities<
  T extends VideoGenerationModeCapabilities | VideoGenerationTransformCapabilities | undefined,
>(base: T, overlay: T): T {
  if (!overlay) {
    return base;
  }
  if (!base) {
    return overlay;
  }
  return mergeVideoGenerationCapabilities(base, overlay);
}

function mergeVideoGenerationProviderCapabilities(
  base: VideoGenerationProviderCapabilities,
  overlay: VideoGenerationProviderCapabilities,
): VideoGenerationProviderCapabilities {
  return {
    ...mergeVideoGenerationCapabilities(base, overlay),
    generate: mergeVideoGenerationModeCapabilities(base.generate, overlay.generate),
    imageToVideo: mergeVideoGenerationModeCapabilities(base.imageToVideo, overlay.imageToVideo),
    videoToVideo: mergeVideoGenerationModeCapabilities(base.videoToVideo, overlay.videoToVideo),
  };
}

export async function resolveProviderWithModelCapabilities(params: {
  provider: VideoGenerationProvider;
  providerId: string;
  model: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  authStore?: GenerateVideoParams["authStore"];
  timeoutMs?: number;
  log: Pick<Console, "debug">;
}): Promise<VideoGenerationProvider> {
  if (!params.provider.resolveModelCapabilities) {
    return params.provider;
  }
  try {
    const modelCapabilities = await params.provider.resolveModelCapabilities({
      provider: params.providerId,
      model: params.model,
      cfg: params.cfg,
      agentDir: params.agentDir,
      authStore: params.authStore,
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    });
    if (!modelCapabilities) {
      return params.provider;
    }
    // Return a request-local provider copy so dynamic model caps cannot leak
    // across later requests or different model candidates.
    return {
      ...params.provider,
      capabilities: mergeVideoGenerationProviderCapabilities(
        params.provider.capabilities,
        modelCapabilities,
      ),
    };
  } catch (err) {
    params.log.debug(
      `video-generation model capability lookup failed for ${params.providerId}/${params.model}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return params.provider;
  }
}
