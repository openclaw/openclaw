const RUNTIME_PROMPT_IMAGE_FACT_INDEXES = Symbol.for("openclaw.runtimePromptImageFactIndexes");

type RuntimePromptImageFactIndex = number | null;

export function finalizeRuntimePromptImages<TImage extends object>(
  entries: readonly { image: TImage; factIndex: RuntimePromptImageFactIndex }[],
): { images: TImage[]; imageFactIndexes: RuntimePromptImageFactIndex[] } {
  const images = entries.map((entry) => entry.image);
  const imageFactIndexes = entries.map((entry) => entry.factIndex);
  // Carry fact ownership without changing provider-visible bytes.
  Object.defineProperty(images, RUNTIME_PROMPT_IMAGE_FACT_INDEXES, {
    configurable: true,
    value: [...imageFactIndexes],
  });
  return { images, imageFactIndexes };
}

export function readRuntimePromptImageFactIndexes(
  images: readonly object[] | null | undefined,
): RuntimePromptImageFactIndex[] | undefined {
  if (!images?.length) {
    return undefined;
  }
  const runtimeImages: readonly object[] & {
    [RUNTIME_PROMPT_IMAGE_FACT_INDEXES]?: unknown;
  } = images;
  const factIndexes = runtimeImages[RUNTIME_PROMPT_IMAGE_FACT_INDEXES];
  return Array.isArray(factIndexes) &&
    factIndexes.length === images.length &&
    factIndexes.every(
      (entry) =>
        entry === null || (typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0),
    )
    ? (factIndexes as RuntimePromptImageFactIndex[])
    : undefined;
}
