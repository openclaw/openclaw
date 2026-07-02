// Image generation capability helpers resolve the active mode and model limits.
import type {
  ImageGenerationEditCapabilities,
  ImageGenerationMode,
  ImageGenerationModeCapabilities,
  ImageGenerationProvider,
} from "./types.js";

export function resolveImageGenerationMode(params: {
  inputImageCount?: number;
}): ImageGenerationMode {
  return (params.inputImageCount ?? 0) > 0 ? "edit" : "generate";
}

export function resolveImageGenerationModeCapabilities(params: {
  provider?: Pick<ImageGenerationProvider, "capabilities">;
  model?: string;
  inputImageCount?: number;
}): {
  mode: ImageGenerationMode;
  capabilities: ImageGenerationModeCapabilities | ImageGenerationEditCapabilities | undefined;
} {
  const mode = resolveImageGenerationMode(params);
  const caps =
    mode === "edit" ? params.provider?.capabilities.edit : params.provider?.capabilities.generate;
  const model = params.model?.trim();
  if (!caps || !model) {
    return { mode, capabilities: caps };
  }
  const maxCount = caps.maxCountByModel?.[model];
  const maxInputImages =
    mode === "edit"
      ? (caps as ImageGenerationEditCapabilities).maxInputImagesByModel?.[model]
      : undefined;
  if (typeof maxCount !== "number" && typeof maxInputImages !== "number") {
    return { mode, capabilities: caps };
  }
  return {
    mode,
    capabilities: {
      ...caps,
      ...(typeof maxCount === "number" ? { maxCount } : {}),
      ...(typeof maxInputImages === "number" ? { maxInputImages } : {}),
    },
  };
}
