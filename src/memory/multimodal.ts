export const MEMORY_MULTIMODAL_MODALITIES = ["image", "audio"] as const;
export type MemoryMultimodalModality = (typeof MEMORY_MULTIMODAL_MODALITIES)[number];
export type MemoryMultimodalSelection = MemoryMultimodalModality | "all";

export type MemoryMultimodalSettings = {
  enabled: boolean;
  modalities: MemoryMultimodalModality[];
  maxFileBytes: number;
};

export const DEFAULT_MEMORY_MULTIMODAL_MAX_FILE_BYTES = 10 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif"]);

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".opus", ".m4a", ".aac", ".flac"]);

export function normalizeMemoryMultimodalModalities(
  raw: MemoryMultimodalSelection[] | undefined,
): MemoryMultimodalModality[] {
  if (raw === undefined || raw.includes("all")) {
    return [...MEMORY_MULTIMODAL_MODALITIES];
  }
  const normalized = new Set<MemoryMultimodalModality>();
  for (const value of raw) {
    if (value === "image" || value === "audio") {
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
    const extensionSet = modality === "image" ? IMAGE_EXTENSIONS : AUDIO_EXTENSIONS;
    for (const extension of extensionSet) {
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
