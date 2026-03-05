// ZHIPU-specific constants
export const ZHIPU_PROVIDER = "zhipu" as const;
export const ZHIPU_BASE_URL = "https://open.bigmodel.cn/api/paas/v4/";

// Modality enum - all supported ZHIPU modalities
export enum Modality {
  TEXT = "text",
  VISION = "vision",
  OCR = "ocr",
  IMAGE_GEN = "image_gen",
  VIDEO_GEN_ASYNC = "video_gen_async",
  VIDEO_POLL = "video_poll",
  AUDIO_TTS = "audio_tts",
  REALTIME = "realtime",
}

// EndpointFamily enum - maps to ZHIPU client functions
export enum EndpointFamily {
  CHAT_VISION = "chat_vision", // zhipuChatCompletions
  OCR = "ocr", // zhipuOcrLayoutParsing
  IMAGES = "images", // zhipuImagesGenerations
  VIDEO_SUBMIT = "video_submit", // zhipuVideosGenerations
  VIDEO_POLL = "video_poll", // zhipuAsyncResult
  AUDIO_TTS = "audio_tts", // zhipuAudioSpeech
  REALTIME = "realtime", // Not implemented yet
}

// Extraction rule types
type ExtractionRule = {
  fieldPath: (string | number)[];
  fallbackFieldPath?: (string | number)[];
  transform?: "first" | "join" | "url" | "freeze";
};

// Retry policy config
type RetryPolicy = {
  retryableHttpStatuses: number[];
  retryableProviderErrorCodes: Record<string, string[]>;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
  defaultTimeoutMs: number;
};

// Model capability structure
type ModelCapability = {
  modelId: string;
  name: string;
  supportedModalities: Modality[];
  endpointFamilyByModality: Partial<Record<Modality, EndpointFamily>>;
  extractionRuleByModality: Partial<Record<Modality, ExtractionRule>>;
  flags?: string[];
  notes?: string[];
};

// ZHIPU-specific retry policies
const ZHIPU_RETRY_POLICIES: Record<EndpointFamily, RetryPolicy> = {
  [EndpointFamily.CHAT_VISION]: {
    retryableHttpStatuses: [408, 429, 500, 502, 503, 504],
    retryableProviderErrorCodes: {
      "1305": ["model_busy", "capacity_limit_reached"], // ZHIPU vision busy errors
    },
    maxAttempts: 3,
    baseDelayMs: 1000,
    maxDelayMs: 10000,
    jitter: true,
    defaultTimeoutMs: 30000,
  },
  [EndpointFamily.OCR]: {
    retryableHttpStatuses: [408, 429, 500, 502, 503, 504],
    retryableProviderErrorCodes: {},
    maxAttempts: 2,
    baseDelayMs: 1000,
    maxDelayMs: 5000,
    jitter: true,
    defaultTimeoutMs: 10000,
  },
  [EndpointFamily.IMAGES]: {
    retryableHttpStatuses: [408, 429, 500, 502, 503, 504],
    retryableProviderErrorCodes: {},
    maxAttempts: 2,
    baseDelayMs: 1000,
    maxDelayMs: 5000,
    jitter: true,
    defaultTimeoutMs: 20000,
  },
  [EndpointFamily.VIDEO_SUBMIT]: {
    retryableHttpStatuses: [408, 429, 500, 502, 503, 504],
    retryableProviderErrorCodes: {},
    maxAttempts: 2,
    baseDelayMs: 1000,
    maxDelayMs: 5000,
    jitter: true,
    defaultTimeoutMs: 30000,
  },
  [EndpointFamily.VIDEO_POLL]: {
    retryableHttpStatuses: [408, 429, 500, 502, 503, 504],
    retryableProviderErrorCodes: {},
    maxAttempts: 10,
    baseDelayMs: 2000,
    maxDelayMs: 30000,
    jitter: true,
    defaultTimeoutMs: 120000,
  },
  [EndpointFamily.AUDIO_TTS]: {
    retryableHttpStatuses: [408, 429, 500, 502, 503, 504],
    retryableProviderErrorCodes: {},
    maxAttempts: 2,
    baseDelayMs: 1000,
    maxDelayMs: 5000,
    jitter: true,
    defaultTimeoutMs: 20000,
  },
  [EndpointFamily.REALTIME]: {
    retryableHttpStatuses: [],
    retryableProviderErrorCodes: {},
    maxAttempts: 1,
    baseDelayMs: 0,
    maxDelayMs: 0,
    jitter: false,
    defaultTimeoutMs: 10000,
  },
};

// Extraction rules aligned to ZHIPU client response shapes
const ZHIPU_EXTRACTION_RULES: Record<Modality, ExtractionRule> = {
  [Modality.TEXT]: {
    fieldPath: ["choices", 0, "message", "content"],
    fallbackFieldPath: ["choices", 0, "message", "reasoning_content"],
    transform: "first",
  },
  [Modality.VISION]: {
    fieldPath: ["choices", 0, "message", "content"],
    fallbackFieldPath: ["choices", 0, "message", "reasoning_content"],
    transform: "first",
  },
  [Modality.OCR]: {
    fieldPath: ["results", 0, "text"], // Based on zhipuOcrLayoutParsing response
    transform: "first",
  },
  [Modality.IMAGE_GEN]: {
    fieldPath: ["data", 0, "url"], // Based on zhipuImagesGenerations response
    transform: "url",
  },
  [Modality.VIDEO_GEN_ASYNC]: {
    fieldPath: ["task_id"], // Based on zhipuVideosGenerations response
    transform: "first",
  },
  [Modality.VIDEO_POLL]: {
    fieldPath: ["video_result", 0, "url"], // Based on zhipuAsyncResult response
    fallbackFieldPath: ["cover_image_url"],
    transform: "freeze",
  },
  [Modality.AUDIO_TTS]: {
    fieldPath: ["data", 0, "url"], // Based on zhipuAudioSpeech response
    transform: "url",
  },
  [Modality.REALTIME]: {
    fieldPath: ["response"],
    transform: "first",
  },
};

// ZHIPU Model Catalog - Pro Team Models
const ZHIPU_PRO_MODELS: ModelCapability[] = [
  {
    modelId: "glm-5",
    name: "GLM-5",
    supportedModalities: [Modality.TEXT],
    endpointFamilyByModality: {
      [Modality.TEXT]: EndpointFamily.CHAT_VISION,
      [Modality.VISION]: EndpointFamily.CHAT_VISION,
      [Modality.OCR]: EndpointFamily.OCR,
      [Modality.IMAGE_GEN]: EndpointFamily.IMAGES,
      [Modality.VIDEO_GEN_ASYNC]: EndpointFamily.VIDEO_SUBMIT,
      [Modality.VIDEO_POLL]: EndpointFamily.VIDEO_POLL,
      [Modality.AUDIO_TTS]: EndpointFamily.AUDIO_TTS,
      [Modality.REALTIME]: EndpointFamily.REALTIME,
    },
    extractionRuleByModality: ZHIPU_EXTRACTION_RULES,
    notes: ["Pro team model"],
  },
  {
    modelId: "glm-4.7",
    name: "GLM-4.7",
    supportedModalities: [Modality.TEXT],
    endpointFamilyByModality: {
      [Modality.TEXT]: EndpointFamily.CHAT_VISION,
      [Modality.VISION]: EndpointFamily.CHAT_VISION,
      [Modality.OCR]: EndpointFamily.OCR,
      [Modality.IMAGE_GEN]: EndpointFamily.IMAGES,
      [Modality.VIDEO_GEN_ASYNC]: EndpointFamily.VIDEO_SUBMIT,
      [Modality.VIDEO_POLL]: EndpointFamily.VIDEO_POLL,
      [Modality.AUDIO_TTS]: EndpointFamily.AUDIO_TTS,
      [Modality.REALTIME]: EndpointFamily.REALTIME,
    },
    extractionRuleByModality: ZHIPU_EXTRACTION_RULES,
    notes: ["Pro team model"],
  },
  {
    modelId: "glm-4.6",
    name: "GLM-4.6",
    supportedModalities: [Modality.TEXT],
    endpointFamilyByModality: {
      [Modality.TEXT]: EndpointFamily.CHAT_VISION,
      [Modality.VISION]: EndpointFamily.CHAT_VISION,
      [Modality.OCR]: EndpointFamily.OCR,
      [Modality.IMAGE_GEN]: EndpointFamily.IMAGES,
      [Modality.VIDEO_GEN_ASYNC]: EndpointFamily.VIDEO_SUBMIT,
      [Modality.VIDEO_POLL]: EndpointFamily.VIDEO_POLL,
      [Modality.AUDIO_TTS]: EndpointFamily.AUDIO_TTS,
      [Modality.REALTIME]: EndpointFamily.REALTIME,
    },
    extractionRuleByModality: ZHIPU_EXTRACTION_RULES,
    notes: ["Pro team model"],
  },
  {
    modelId: "glm-4.5-air",
    name: "GLM-4.5 Air",
    supportedModalities: [Modality.TEXT],
    endpointFamilyByModality: {
      [Modality.TEXT]: EndpointFamily.CHAT_VISION,
      [Modality.VISION]: EndpointFamily.CHAT_VISION,
      [Modality.OCR]: EndpointFamily.OCR,
      [Modality.IMAGE_GEN]: EndpointFamily.IMAGES,
      [Modality.VIDEO_GEN_ASYNC]: EndpointFamily.VIDEO_SUBMIT,
      [Modality.VIDEO_POLL]: EndpointFamily.VIDEO_POLL,
      [Modality.AUDIO_TTS]: EndpointFamily.AUDIO_TTS,
      [Modality.REALTIME]: EndpointFamily.REALTIME,
    },
    extractionRuleByModality: ZHIPU_EXTRACTION_RULES,
    notes: ["Pro team model"],
  },
  {
    modelId: "glm-4.6v",
    name: "GLM-4.6V",
    supportedModalities: [Modality.TEXT, Modality.VISION],
    endpointFamilyByModality: {
      [Modality.TEXT]: EndpointFamily.CHAT_VISION,
      [Modality.VISION]: EndpointFamily.CHAT_VISION,
      [Modality.OCR]: EndpointFamily.OCR,
      [Modality.IMAGE_GEN]: EndpointFamily.IMAGES,
      [Modality.VIDEO_GEN_ASYNC]: EndpointFamily.VIDEO_SUBMIT,
      [Modality.VIDEO_POLL]: EndpointFamily.VIDEO_POLL,
      [Modality.AUDIO_TTS]: EndpointFamily.AUDIO_TTS,
      [Modality.REALTIME]: EndpointFamily.REALTIME,
    },
    extractionRuleByModality: ZHIPU_EXTRACTION_RULES,
    notes: ["Pro team vision model"],
  },
  {
    modelId: "glm-image",
    name: "GLM Image",
    supportedModalities: [Modality.IMAGE_GEN],
    endpointFamilyByModality: {
      [Modality.TEXT]: EndpointFamily.CHAT_VISION,
      [Modality.VISION]: EndpointFamily.CHAT_VISION,
      [Modality.OCR]: EndpointFamily.OCR,
      [Modality.IMAGE_GEN]: EndpointFamily.IMAGES,
      [Modality.VIDEO_GEN_ASYNC]: EndpointFamily.VIDEO_SUBMIT,
      [Modality.VIDEO_POLL]: EndpointFamily.VIDEO_POLL,
      [Modality.AUDIO_TTS]: EndpointFamily.AUDIO_TTS,
      [Modality.REALTIME]: EndpointFamily.REALTIME,
    },
    extractionRuleByModality: ZHIPU_EXTRACTION_RULES,
    notes: ["Pro team image generation model"],
  },
  {
    modelId: "cogvideox-3",
    name: "CogVideoX-3",
    supportedModalities: [Modality.VIDEO_GEN_ASYNC, Modality.VIDEO_POLL],
    endpointFamilyByModality: {
      [Modality.TEXT]: EndpointFamily.CHAT_VISION,
      [Modality.VISION]: EndpointFamily.CHAT_VISION,
      [Modality.OCR]: EndpointFamily.OCR,
      [Modality.IMAGE_GEN]: EndpointFamily.IMAGES,
      [Modality.VIDEO_GEN_ASYNC]: EndpointFamily.VIDEO_SUBMIT,
      [Modality.VIDEO_POLL]: EndpointFamily.VIDEO_POLL,
      [Modality.AUDIO_TTS]: EndpointFamily.AUDIO_TTS,
      [Modality.REALTIME]: EndpointFamily.REALTIME,
    },
    extractionRuleByModality: ZHIPU_EXTRACTION_RULES,
    notes: ["Pro team video generation model"],
  },
  {
    modelId: "cogView-4-250304",
    name: "CogView-4",
    supportedModalities: [Modality.IMAGE_GEN],
    endpointFamilyByModality: {
      [Modality.TEXT]: EndpointFamily.CHAT_VISION,
      [Modality.VISION]: EndpointFamily.CHAT_VISION,
      [Modality.OCR]: EndpointFamily.OCR,
      [Modality.IMAGE_GEN]: EndpointFamily.IMAGES,
      [Modality.VIDEO_GEN_ASYNC]: EndpointFamily.VIDEO_SUBMIT,
      [Modality.VIDEO_POLL]: EndpointFamily.VIDEO_POLL,
      [Modality.AUDIO_TTS]: EndpointFamily.AUDIO_TTS,
      [Modality.REALTIME]: EndpointFamily.REALTIME,
    },
    extractionRuleByModality: ZHIPU_EXTRACTION_RULES,
    notes: ["Pro team image generation model"],
  },
  {
    modelId: "glm-ocr",
    name: "GLM-OCR",
    supportedModalities: [Modality.OCR],
    endpointFamilyByModality: {
      [Modality.OCR]: EndpointFamily.OCR,
    },
    extractionRuleByModality: {
      [Modality.OCR]: ZHIPU_EXTRACTION_RULES[Modality.OCR],
    },
    notes: ["OCR specialist model"],
  },
  {
    modelId: "glm-tts",
    name: "GLM-TTS",
    supportedModalities: [Modality.AUDIO_TTS],
    endpointFamilyByModality: {
      [Modality.AUDIO_TTS]: EndpointFamily.AUDIO_TTS,
    },
    extractionRuleByModality: {
      [Modality.AUDIO_TTS]: ZHIPU_EXTRACTION_RULES[Modality.AUDIO_TTS],
    },
    notes: ["TTS specialist model"],
  },
  {
    modelId: "glm-tts-clone",
    name: "GLM-TTS-CLONE",
    supportedModalities: [Modality.AUDIO_TTS],
    endpointFamilyByModality: {
      [Modality.AUDIO_TTS]: EndpointFamily.AUDIO_TTS,
    },
    extractionRuleByModality: {
      [Modality.AUDIO_TTS]: ZHIPU_EXTRACTION_RULES[Modality.AUDIO_TTS],
    },
    notes: ["TTS clone specialist model"],
  },
];

// ZHIPU Model Catalog - Free Team Models
const ZHIPU_FREE_MODELS: ModelCapability[] = [
  {
    modelId: "glm-4.7-flash",
    name: "GLM-4.7 Flash",
    supportedModalities: [Modality.TEXT],
    endpointFamilyByModality: {
      [Modality.TEXT]: EndpointFamily.CHAT_VISION,
      [Modality.VISION]: EndpointFamily.CHAT_VISION,
      [Modality.OCR]: EndpointFamily.OCR,
      [Modality.IMAGE_GEN]: EndpointFamily.IMAGES,
      [Modality.VIDEO_GEN_ASYNC]: EndpointFamily.VIDEO_SUBMIT,
      [Modality.VIDEO_POLL]: EndpointFamily.VIDEO_POLL,
      [Modality.AUDIO_TTS]: EndpointFamily.AUDIO_TTS,
      [Modality.REALTIME]: EndpointFamily.REALTIME,
    },
    extractionRuleByModality: ZHIPU_EXTRACTION_RULES,
    flags: ["free_tier"],
    notes: ["Free team model"],
  },
  {
    modelId: "glm-4.5-flash",
    name: "GLM-4.5 Flash",
    supportedModalities: [Modality.TEXT],
    endpointFamilyByModality: {
      [Modality.TEXT]: EndpointFamily.CHAT_VISION,
      [Modality.VISION]: EndpointFamily.CHAT_VISION,
      [Modality.OCR]: EndpointFamily.OCR,
      [Modality.IMAGE_GEN]: EndpointFamily.IMAGES,
      [Modality.VIDEO_GEN_ASYNC]: EndpointFamily.VIDEO_SUBMIT,
      [Modality.VIDEO_POLL]: EndpointFamily.VIDEO_POLL,
      [Modality.AUDIO_TTS]: EndpointFamily.AUDIO_TTS,
      [Modality.REALTIME]: EndpointFamily.REALTIME,
    },
    extractionRuleByModality: ZHIPU_EXTRACTION_RULES,
    flags: ["free_tier"],
    notes: ["Free team model"],
  },
  {
    modelId: "glm-4.6v-flash",
    name: "GLM-4.6V Flash",
    supportedModalities: [Modality.TEXT, Modality.VISION],
    endpointFamilyByModality: {
      [Modality.TEXT]: EndpointFamily.CHAT_VISION,
      [Modality.VISION]: EndpointFamily.CHAT_VISION,
      [Modality.OCR]: EndpointFamily.OCR,
      [Modality.IMAGE_GEN]: EndpointFamily.IMAGES,
      [Modality.VIDEO_GEN_ASYNC]: EndpointFamily.VIDEO_SUBMIT,
      [Modality.VIDEO_POLL]: EndpointFamily.VIDEO_POLL,
      [Modality.AUDIO_TTS]: EndpointFamily.AUDIO_TTS,
      [Modality.REALTIME]: EndpointFamily.REALTIME,
    },
    extractionRuleByModality: ZHIPU_EXTRACTION_RULES,
    flags: ["free_tier", "capacity_risk"],
    notes: ["Free team vision model - capacity risk"],
  },
  {
    modelId: "cogview-3-flash",
    name: "CogView-3 Flash",
    supportedModalities: [Modality.IMAGE_GEN],
    endpointFamilyByModality: {
      [Modality.TEXT]: EndpointFamily.CHAT_VISION,
      [Modality.VISION]: EndpointFamily.CHAT_VISION,
      [Modality.OCR]: EndpointFamily.OCR,
      [Modality.IMAGE_GEN]: EndpointFamily.IMAGES,
      [Modality.VIDEO_GEN_ASYNC]: EndpointFamily.VIDEO_SUBMIT,
      [Modality.VIDEO_POLL]: EndpointFamily.VIDEO_POLL,
      [Modality.AUDIO_TTS]: EndpointFamily.AUDIO_TTS,
      [Modality.REALTIME]: EndpointFamily.REALTIME,
    },
    extractionRuleByModality: ZHIPU_EXTRACTION_RULES,
    flags: ["free_tier"],
    notes: ["Free team image generation model"],
  },
  {
    modelId: "cogvideox-flash",
    name: "CogVideoX Flash",
    supportedModalities: [Modality.VIDEO_GEN_ASYNC, Modality.VIDEO_POLL],
    endpointFamilyByModality: {
      [Modality.TEXT]: EndpointFamily.CHAT_VISION,
      [Modality.VISION]: EndpointFamily.CHAT_VISION,
      [Modality.OCR]: EndpointFamily.OCR,
      [Modality.IMAGE_GEN]: EndpointFamily.IMAGES,
      [Modality.VIDEO_GEN_ASYNC]: EndpointFamily.VIDEO_SUBMIT,
      [Modality.VIDEO_POLL]: EndpointFamily.VIDEO_POLL,
      [Modality.AUDIO_TTS]: EndpointFamily.AUDIO_TTS,
      [Modality.REALTIME]: EndpointFamily.REALTIME,
    },
    extractionRuleByModality: ZHIPU_EXTRACTION_RULES,
    flags: ["free_tier"],
    notes: ["Free team video generation model"],
  },
];

// Helper function to match viduq1-* pattern
function matchesViduq1Pattern(modelId: string): boolean {
  return modelId.startsWith("viduq1-");
}

// Complete ZHIPU model catalog
export const ZHIPU_MODEL_CATALOG: ModelCapability[] = [
  ...ZHIPU_PRO_MODELS,
  ...ZHIPU_FREE_MODELS,
  // Add viduq1 pattern match for video generation
  {
    modelId: "viduq1-*",
    name: "Vidu Q1 Pattern",
    supportedModalities: [Modality.VIDEO_GEN_ASYNC, Modality.VIDEO_POLL],
    endpointFamilyByModality: {
      [Modality.TEXT]: EndpointFamily.CHAT_VISION,
      [Modality.VISION]: EndpointFamily.CHAT_VISION,
      [Modality.OCR]: EndpointFamily.OCR,
      [Modality.IMAGE_GEN]: EndpointFamily.IMAGES,
      [Modality.VIDEO_GEN_ASYNC]: EndpointFamily.VIDEO_SUBMIT,
      [Modality.VIDEO_POLL]: EndpointFamily.VIDEO_POLL,
      [Modality.AUDIO_TTS]: EndpointFamily.AUDIO_TTS,
      [Modality.REALTIME]: EndpointFamily.REALTIME,
    },
    extractionRuleByModality: ZHIPU_EXTRACTION_RULES,
    notes: ["Pattern match for viduq1-* video models"],
  },
];

// Query API functions
export function getCapability(modelId: string): ModelCapability | null {
  // Handle viduq1-* pattern match
  if (matchesViduq1Pattern(modelId)) {
    const patternCapability = ZHIPU_MODEL_CATALOG.find((cap) => cap.modelId === "viduq1-*");
    if (patternCapability) {
      return {
        ...patternCapability,
        modelId: modelId, // Use the actual model ID
      };
    }
  }

  return ZHIPU_MODEL_CATALOG.find((cap) => cap.modelId === modelId) || null;
}

export function supports(modelId: string, modality: Modality): boolean {
  const capability = getCapability(modelId);
  return capability ? capability.supportedModalities.includes(modality) : false;
}

export function endpointFor(modelId: string, modality: Modality): EndpointFamily | null {
  const capability = getCapability(modelId);
  if (!capability || !capability.supportedModalities.includes(modality)) {
    return null;
  }
  return capability.endpointFamilyByModality[modality] ?? null;
}

export function extractionFor(modelId: string, modality: Modality): ExtractionRule | null {
  const capability = getCapability(modelId);
  if (!capability || !capability.supportedModalities.includes(modality)) {
    return null;
  }
  return capability.extractionRuleByModality[modality] ?? null;
}

export function retryPolicyFor(endpointFamily: EndpointFamily): RetryPolicy | null {
  return ZHIPU_RETRY_POLICIES[endpointFamily] || null;
}

// Helper to get all model IDs
export function getAllModelIds(): string[] {
  return ZHIPU_MODEL_CATALOG.map((cap) => cap.modelId);
}

// Helper to get model IDs by modality
export function getModelIdsByModality(modality: Modality): string[] {
  return ZHIPU_MODEL_CATALOG.filter((cap) => cap.supportedModalities.includes(modality)).map(
    (cap) => cap.modelId,
  );
}

// Helper to get model IDs by tier
export function getModelIdsByTier(tier: "pro" | "free"): string[] {
  return ZHIPU_MODEL_CATALOG.filter(
    (cap) =>
      (tier === "pro" && !cap.flags?.includes("free_tier")) ||
      (tier === "free" && cap.flags?.includes("free_tier")),
  ).map((cap) => cap.modelId);
}
