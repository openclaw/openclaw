import type {
  VideoGenerationMode,
  VideoGenerationModeCapabilities,
  VideoGenerationProvider,
  VideoGenerationProviderCapabilities,
  VideoGenerationTransformCapabilities,
} from "./types.js";

function pickModeCapabilities(
  capabilities: VideoGenerationProviderCapabilities,
): VideoGenerationModeCapabilities {
  return {
    maxVideos: capabilities.maxVideos,
    maxInputImages: capabilities.maxInputImages,
    maxInputVideos: capabilities.maxInputVideos,
    maxDurationSeconds: capabilities.maxDurationSeconds,
    supportedDurationSeconds: capabilities.supportedDurationSeconds,
    supportedDurationSecondsByModel: capabilities.supportedDurationSecondsByModel,
    supportsSize: capabilities.supportsSize,
    supportsAspectRatio: capabilities.supportsAspectRatio,
    supportsResolution: capabilities.supportsResolution,
    supportsAudio: capabilities.supportsAudio,
    supportsWatermark: capabilities.supportsWatermark,
  };
}

function deriveLegacyImageToVideoCapabilities(
  capabilities: VideoGenerationProviderCapabilities,
): VideoGenerationTransformCapabilities {
  return {
    ...pickModeCapabilities(capabilities),
    enabled: (capabilities.maxInputImages ?? 0) > 0,
  };
}

function deriveLegacyVideoToVideoCapabilities(
  capabilities: VideoGenerationProviderCapabilities,
): VideoGenerationTransformCapabilities {
  return {
    ...pickModeCapabilities(capabilities),
    enabled: (capabilities.maxInputVideos ?? 0) > 0,
  };
}

export function resolveVideoGenerationMode(params: {
  inputImageCount?: number;
  inputVideoCount?: number;
}): VideoGenerationMode | null {
  const inputImageCount = params.inputImageCount ?? 0;
  const inputVideoCount = params.inputVideoCount ?? 0;
  if (inputImageCount > 0 && inputVideoCount > 0) {
    return null;
  }
  if (inputVideoCount > 0) {
    return "videoToVideo";
  }
  if (inputImageCount > 0) {
    return "imageToVideo";
  }
  return "generate";
}

export function listSupportedVideoGenerationModes(
  provider: Pick<VideoGenerationProvider, "capabilities">,
): VideoGenerationMode[] {
  const modes: VideoGenerationMode[] = ["generate"];
  const imageToVideo =
    provider.capabilities.imageToVideo ??
    deriveLegacyImageToVideoCapabilities(provider.capabilities);
  if (imageToVideo.enabled) {
    modes.push("imageToVideo");
  }
  const videoToVideo =
    provider.capabilities.videoToVideo ??
    deriveLegacyVideoToVideoCapabilities(provider.capabilities);
  if (videoToVideo.enabled) {
    modes.push("videoToVideo");
  }
  return modes;
}

export function resolveVideoGenerationModeCapabilities(params: {
  provider?: Pick<VideoGenerationProvider, "capabilities">;
  inputImageCount?: number;
  inputVideoCount?: number;
}): {
  mode: VideoGenerationMode | null;
  capabilities: VideoGenerationModeCapabilities | VideoGenerationTransformCapabilities | undefined;
} {
  const mode = resolveVideoGenerationMode(params);
  const capabilities = params.provider?.capabilities;
  if (!capabilities) {
    return { mode, capabilities: undefined };
  }
  if (mode === "generate") {
    return {
      mode,
      capabilities: capabilities.generate ?? pickModeCapabilities(capabilities),
    };
  }
  if (mode === "imageToVideo") {
    return {
      mode,
      capabilities: capabilities.imageToVideo ?? deriveLegacyImageToVideoCapabilities(capabilities),
    };
  }
  if (mode === "videoToVideo") {
    return {
      mode,
      capabilities: capabilities.videoToVideo ?? deriveLegacyVideoToVideoCapabilities(capabilities),
    };
  }
  return {
    mode,
    capabilities: pickModeCapabilities(capabilities),
  };
}
