type ReturnedImage = {
  metadata?: Record<string, unknown>;
};

function returnedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function returnedSize(params: {
  value: unknown;
  observedSize: string | undefined;
  useObservedFallback: boolean;
}): string | undefined {
  const returned = returnedString(params.value);
  return returned && /^\d+x\d+$/.test(returned)
    ? returned
    : returned || params.useObservedFallback
      ? params.observedSize
      : undefined;
}

function returnedQuality(value: unknown): string | undefined {
  const returned = returnedString(value);
  return returned && ["low", "medium", "high", "xhigh", "max"].includes(returned)
    ? returned
    : undefined;
}

function sharedSetting(values: Array<string | undefined>): string | undefined {
  const first = values[0];
  return first !== undefined && values.every((value) => value === first) ? first : undefined;
}

export function buildReturnedImageSettingsDetails(params: {
  images: ReturnedImage[];
  paths: string[];
  observedSizes?: Array<string | undefined>;
  requestedSize?: string;
  requestedQuality?: string;
  fallbackSize?: string;
}): Record<string, unknown> {
  const hasReturnedSizes = params.images.some((image) => returnedString(image.metadata?.size));
  const hasReturnedQualities = params.images.some((image) =>
    returnedString(image.metadata?.quality),
  );
  const hasReturnedSettings = hasReturnedSizes || hasReturnedQualities;
  const imageSettings = params.images.map((image, index) => {
    return {
      path: params.paths[index],
      size: returnedSize({
        value: image.metadata?.size,
        observedSize: params.observedSizes?.[index],
        useObservedFallback: hasReturnedSettings,
      }),
      quality: returnedQuality(image.metadata?.quality),
    };
  });
  const returnedSizes = imageSettings.map((settings) => settings.size);
  const returnedQualities = imageSettings.map((settings) => settings.quality);
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
      : hasReturnedSettings
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
      : hasReturnedSettings
        ? params.requestedQuality
          ? { requestedQuality: params.requestedQuality }
          : {}
        : params.requestedQuality
          ? { quality: params.requestedQuality }
          : {}),
  };
}
