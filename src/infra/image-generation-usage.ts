/**
 * Image Generation Usage Metadata
 *
 * Tracks image generation requests for analytics and cost awareness.
 * Stores: provider, model, timestamp, success/failure, output references.
 */

export interface ImageGenerationUsageRecord {
  /** Unique id for this record */
  id: string;
  /** Provider that handled the request (e.g. "openai", "google") */
  provider: string;
  /** Model used (e.g. "gpt-image-2", "imagen-3") */
  model: string;
  /** Unix timestamp ms when generation completed */
  timestamp: number;
  /** Whether the generation succeeded */
  success: boolean;
  /** Number of images generated */
  count: number;
  /** Output file paths or media URLs */
  outputUrls: string[];
  /** Optional session key */
  sessionKey?: string;
  /** Optional error message if success=false */
  error?: string;
  /** Optional generation cost estimate if known */
  cost?: number;
  /** Optional media ID for the generated content */
  mediaId?: string;
}

export interface RecordImageGenerationParams {
  provider: string;
  model: string;
  success: boolean;
  count: number;
  outputUrls: string[];
  sessionKey?: string;
  error?: string;
  cost?: number;
  mediaId?: string;
}

// In-memory store — single process, reset on restart
const usageStore: ImageGenerationUsageRecord[] = [];

let recordCounter = 0;

/**
 * Record an image generation event.
 */
export function recordImageGeneration(params: RecordImageGenerationParams): ImageGenerationUsageRecord {
  const record: ImageGenerationUsageRecord = {
    id: `img-gen-${Date.now()}-${++recordCounter}`,
    provider: params.provider,
    model: params.model,
    timestamp: Date.now(),
    success: params.success,
    count: params.count,
    outputUrls: params.outputUrls,
    sessionKey: params.sessionKey,
    ...(params.error ? { error: params.error } : {}),
    ...(params.cost !== undefined ? { cost: params.cost } : {}),
    ...(params.mediaId ? { mediaId: params.mediaId } : {}),
  };
  usageStore.push(record);
  return record;
}

/**
 * Get all recorded image generation events.
 */
export function getImageGenerationUsage(): ImageGenerationUsageRecord[] {
  return [...usageStore];
}

/**
 * Get recent image generation events, newest first.
 */
export function getRecentImageGenerationUsage(params?: {
  limit?: number;
  sinceMs?: number;
  provider?: string;
  model?: string;
}): ImageGenerationUsageRecord[] {
  let records = usageStore;

  if (params?.sinceMs !== undefined) {
    records = records.filter((r) => r.timestamp >= params.sinceMs!);
  }
  if (params?.provider !== undefined) {
    records = records.filter((r) => r.provider === params.provider);
  }
  if (params?.model !== undefined) {
    records = records.filter((r) => r.model === params.model);
  }

  const sorted = records.toSorted((a, b) => b.timestamp - a.timestamp);
  if (params?.limit !== undefined) {
    return sorted.slice(0, params.limit);
  }
  return sorted;
}

/**
 * Clear all usage records (primarily for testing).
 */
export function clearImageGenerationUsage(): void {
  usageStore.length = 0;
  recordCounter = 0;
}

/**
 * Get usage summary stats.
 */
export function getImageGenerationUsageSummary(params?: {
  sinceMs?: number;
}): {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  totalImagesGenerated: number;
  providers: Record<string, number>;
  models: Record<string, number>;
} {
  let records = usageStore;
  if (params?.sinceMs !== undefined) {
    records = records.filter((r) => r.timestamp >= params.sinceMs!);
  }

  const providers: Record<string, number> = {};
  const models: Record<string, number> = {};
  let totalImages = 0;

  for (const record of records) {
    providers[record.provider] = (providers[record.provider] ?? 0) + 1;
    models[record.model] = (models[record.model] ?? 0) + 1;
    if (record.success) {
      totalImages += record.count;
    }
  }

  return {
    totalRequests: records.length,
    successfulRequests: records.filter((r) => r.success).length,
    failedRequests: records.filter((r) => !r.success).length,
    totalImagesGenerated: totalImages,
    providers,
    models,
  };
}