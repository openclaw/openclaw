import type { ImageGenerationProvider } from "./types.js";

export function resolveImageGenerationMaxInputImages(params: {
  provider: Pick<ImageGenerationProvider, "capabilities">;
  model?: string;
}): number | undefined {
  const model = params.model?.trim();
  return (
    (model ? params.provider.capabilities.edit.maxInputImagesByModel?.[model] : undefined) ??
    params.provider.capabilities.edit.maxInputImages
  );
}
