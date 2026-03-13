type MemoryMultimodalSpec = {
  labelPrefix: string;
  extensions: string[];
  matchesMimeType: (mimeType: string) => boolean;
};

const MEMORY_MULTIMODAL_SPECS = {
  image: {
    labelPrefix: "Image file",
    extensions: [".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif"],
    matchesMimeType: (mimeType: string) => mimeType.startsWith("image/"),
  },
  audio: {
    labelPrefix: "Audio file",
    extensions: [".mp3", ".wav", ".ogg", ".opus", ".m4a", ".aac", ".flac"],
    matchesMimeType: (mimeType: string) => mimeType.startsWith("audio/"),
  },
  video: {
    labelPrefix: "Video file",
    extensions: [".mp4", ".mov"],
    matchesMimeType: (mimeType: string) => mimeType.startsWith("video/"),
  },
  pdf: {
    labelPrefix: "PDF file",
    extensions: [".pdf"],
    matchesMimeType: (mimeType: string) => mimeType === "application/pdf",
  },
} satisfies Record<string, MemoryMultimodalSpec>;

export type MemoryMultimodalModality = keyof typeof MEMORY_MULTIMODAL_SPECS;
export const MEMORY_MULTIMODAL_MODALITIES = Object.keys(
  MEMORY_MULTIMODAL_SPECS,
) as MemoryMultimodalModality[];
export type MemoryMultimodalSelection = MemoryMultimodalModality | "all";

export type MemoryMultimodalSettings = {
  enabled: boolean;
  modalities: MemoryMultimodalModality[];
  maxFileBytes: number;
};

export const DEFAULT_MEMORY_MULTIMODAL_MAX_FILE_BYTES = 10 * 1024 * 1024;

export function normalizeMemoryMultimodalModalities(
  raw: MemoryMultimodalSelection[] | undefined,
): MemoryMultimodalModality[] {
  if (raw === undefined || raw.includes("all")) {
    return [...MEMORY_MULTIMODAL_MODALITIES];
  }
  const normalized = new Set<MemoryMultimodalModality>();
  for (const value of raw) {
    if (value !== "all" && value in MEMORY_MULTIMODAL_SPECS) {
      normalized.add(value);
    }
  }
  return Array.from(normalized);
}

export function normalizeMemoryMultimodalSettings(raw: {
  enabled?: boolean;
  modalities?: MemoryMultimodalSelection[];
  maxFileBytes?: number;
}): MemoryMultimodalSettings {
  const enabled = raw.enabled === true;
  const maxFileBytes =
    typeof raw.maxFileBytes === "number" && Number.isFinite(raw.maxFileBytes)
      ? Math.max(1, Math.floor(raw.maxFileBytes))
      : DEFAULT_MEMORY_MULTIMODAL_MAX_FILE_BYTES;
  return {
    enabled,
    modalities: enabled ? normalizeMemoryMultimodalModalities(raw.modalities) : [],
    maxFileBytes,
  };
}

export function isMemoryMultimodalEnabled(settings: MemoryMultimodalSettings): boolean {
  return settings.enabled && settings.modalities.length > 0;
}

export function getMemoryMultimodalExtensions(
  modality: MemoryMultimodalModality,
): readonly string[] {
  return MEMORY_MULTIMODAL_SPECS[modality].extensions;
}

export function buildMemoryMultimodalLabel(
  modality: MemoryMultimodalModality,
  normalizedPath: string,
): string {
  return `${MEMORY_MULTIMODAL_SPECS[modality].labelPrefix}: ${normalizedPath}`;
}

export function isSupportedMemoryMultimodalMimeType(
  modality: MemoryMultimodalModality,
  mimeType: string,
): boolean {
  return MEMORY_MULTIMODAL_SPECS[modality].matchesMimeType(mimeType);
}

export function buildCaseInsensitiveExtensionGlob(extension: string): string {
  const normalized = extension.trim().replace(/^\./, "").toLowerCase();
  if (!normalized) {
    return "*";
  }
  const parts = Array.from(normalized, (char) => `[${char.toLowerCase()}${char.toUpperCase()}]`);
  return `*.${parts.join("")}`;
}

export function classifyMemoryMultimodalPath(
  filePath: string,
  settings: MemoryMultimodalSettings,
): MemoryMultimodalModality | null {
  if (!isMemoryMultimodalEnabled(settings)) {
    return null;
  }
  const lower = filePath.trim().toLowerCase();
  for (const modality of settings.modalities) {
    for (const extension of getMemoryMultimodalExtensions(modality)) {
      if (lower.endsWith(extension)) {
        return modality;
      }
    }
  }
  return null;
}

export function normalizeGeminiEmbeddingModelForMemory(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/^models\//, "").replace(/^(gemini|google)\//, "");
}

export function supportsMemoryMultimodalEmbeddings(params: {
  provider: string;
  model: string;
}): boolean {
  if (params.provider !== "gemini") {
    return false;
  }
  return normalizeGeminiEmbeddingModelForMemory(params.model) === "gemini-embedding-2-preview";
}
