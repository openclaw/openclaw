type ReturnedImage = {
  metadata?: Record<string, unknown>;
};

function returnedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function sharedSetting(values: Array<string | undefined>): string | undefined {
  const first = values[0];
  return first !== undefined && values.every((value) => value === first) ? first : undefined;
}

export function buildReturnedImageSettingsDetails(params: {
  images: ReturnedImage[];
  paths: string[];
  requestedSize?: string;
  requestedQuality?: string;
  fallbackSize?: string;
}): Record<string, unknown> {
  const imageSettings = params.images.map((image, index) => ({
    path: params.paths[index],
    size: returnedString(image.metadata?.size),
    quality: returnedString(image.metadata?.quality),
  }));
  const returnedSizes = imageSettings.map((settings) => settings.size);
  const returnedQualities = imageSettings.map((settings) => settings.quality);
  const hasReturnedSizes = returnedSizes.some(Boolean);
  const hasReturnedQualities = returnedQualities.some(Boolean);
  const appliedSize = sharedSetting(returnedSizes);
  const appliedQuality = sharedSetting(returnedQualities);

  return {
    ...(hasReturnedSizes || hasReturnedQualities ? { imageSettings } : {}),
    ...(appliedSize
      ? {
          size: appliedSize,
          ...(params.requestedSize && appliedSize !== params.requestedSize
            ? { requestedSize: params.requestedSize }
            : {}),
        }
      : hasReturnedSizes
        ? params.requestedSize
          ? { requestedSize: params.requestedSize }
          : {}
        : params.fallbackSize
          ? { size: params.fallbackSize }
          : {}),
    ...(appliedQuality
      ? {
          quality: appliedQuality,
          ...(params.requestedQuality && appliedQuality !== params.requestedQuality
            ? { requestedQuality: params.requestedQuality }
            : {}),
        }
      : hasReturnedQualities
        ? params.requestedQuality
          ? { requestedQuality: params.requestedQuality }
          : {}
        : params.requestedQuality
          ? { quality: params.requestedQuality }
          : {}),
  };
}
