/**
 * Model response caching integration
 * Caches model responses for similar prompts
 */

import crypto from "node:crypto";
import type { CacheManager } from "../cache-manager.js";

export type ModelRequestParams = {
  model: string;
  messages: Array<{
    role: string;
    content: string;
  }>;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  tools?: unknown[];
};

export type ModelResponse = {
  content: string;
  model: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  cached?: boolean;
  cacheKey?: string;
  similarityScore?: number;
};

/**
 * Options for model response caching
 */
export type ModelCacheOptions = {
  enableSimilarityMatching?: boolean;
  similarityThreshold?: number; // 0-1, default 0.95
  ignoreSystemPrompt?: boolean;
  maxCacheSize?: number;
};

const DEFAULT_OPTIONS: ModelCacheOptions = {
  enableSimilarityMatching: true,
  similarityThreshold: 0.95,
  ignoreSystemPrompt: false,
  maxCacheSize: 50,
};

/**
 * Create a cached model call function
 */
export function createCachedModelCall(
  cache: CacheManager,
  originalCall: (params: ModelRequestParams) => Promise<ModelResponse>,
  options: ModelCacheOptions = {},
) {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  return async function cachedModelCall(params: ModelRequestParams): Promise<ModelResponse> {
    // Don't cache if temperature is high (non-deterministic)
    if ((params.temperature ?? 0) > 0.3) {
      const result = await originalCall(params);
      return { ...result, cached: false };
    }

    // Don't cache if tools are involved (function calling)
    if (params.tools && params.tools.length > 0) {
      const result = await originalCall(params);
      return { ...result, cached: false };
    }

    // Generate cache key
    const cacheKey = generateModelCacheKey(params, opts);

    // Try exact match first
    const exact = await cache.get<ModelResponse>("model-response", cacheKey);
    if (exact) {
      return {
        ...exact,
        cached: true,
        cacheKey,
        similarityScore: 1.0,
      };
    }

    // Try similarity matching if enabled
    if (opts.enableSimilarityMatching) {
      const similar = await findSimilarResponse(cache, params, opts);
      if (similar && similar.score >= (opts.similarityThreshold ?? 0.95)) {
        return {
          ...similar.response,
          cached: true,
          cacheKey,
          similarityScore: similar.score,
        };
      }
    }

    // Call the model and cache the response
    const response = await originalCall(params);

    // Cache the response
    await cache.set("model-response", cacheKey, response, {
      ttl: calculateTTL(params, response),
      tags: ["model", params.model],
    });

    // Also store for similarity matching
    if (opts.enableSimilarityMatching) {
      await storeForSimilarity(cache, params, response);
    }

    return {
      ...response,
      cached: false,
      cacheKey,
    };
  };
}

/**
 * Generate a deterministic cache key for model parameters
 */
function generateModelCacheKey(params: ModelRequestParams, options: ModelCacheOptions): string {
  const keyData = {
    model: params.model,
    messages: params.messages.map((m) => ({
      role: m.role,
      content: normalizeContent(m.content),
    })),
    temperature: params.temperature ?? 0,
    maxTokens: params.maxTokens,
  };

  if (!options.ignoreSystemPrompt && params.systemPrompt) {
    keyData["systemPrompt"] = normalizeContent(params.systemPrompt);
  }

  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify(keyData))
    .digest("hex")
    .substring(0, 16);

  return `model:${params.model}:${hash}`;
}

/**
 * Normalize content for consistent caching
 */
function normalizeContent(content: string): string {
  return content.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Calculate TTL based on request and response characteristics
 */
function calculateTTL(params: ModelRequestParams, response: ModelResponse): number {
  // Shorter TTL for short responses (might be errors or incomplete)
  if (response.content.length < 100) {
    return 300; // 5 minutes
  }

  // Longer TTL for factual queries (detected by keywords)
  const factualKeywords = ["define", "what is", "explain", "how does", "when was", "who is"];
  const lastMessage = params.messages[params.messages.length - 1]?.content.toLowerCase() || "";

  if (factualKeywords.some((kw) => lastMessage.includes(kw))) {
    return 1800; // 30 minutes
  }

  // Default TTL
  return 600; // 10 minutes
}

/**
 * Find similar cached responses using simple text similarity
 */
async function findSimilarResponse(
  cache: CacheManager,
  params: ModelRequestParams,
  options: ModelCacheOptions,
): Promise<{ response: ModelResponse; score: number } | null> {
  // This is a simplified implementation
  // In production, you might want to use embeddings for better similarity matching

  // For now, just check if the last user message is very similar
  const lastMessage = params.messages[params.messages.length - 1]?.content || "";
  const normalizedMessage = normalizeContent(lastMessage);

  // Generate a few variations to check
  const variations = [
    normalizedMessage,
    normalizedMessage.replace(/[.,!?;:]/g, ""),
    normalizedMessage.substring(0, Math.min(50, normalizedMessage.length)),
  ];

  for (const variation of variations) {
    const varKey = {
      model: params.model,
      messageStart: variation.substring(0, 20),
    };

    const cached = await cache.get<ModelResponse>("model-response", varKey);
    if (cached) {
      const score = calculateSimilarity(lastMessage, variation);
      if (score >= (options.similarityThreshold ?? 0.95)) {
        return { response: cached, score };
      }
    }
  }

  return null;
}

/**
 * Simple text similarity calculation
 */
function calculateSimilarity(text1: string, text2: string): number {
  const norm1 = normalizeContent(text1);
  const norm2 = normalizeContent(text2);

  if (norm1 === norm2) {
    return 1.0;
  }

  // Levenshtein distance-based similarity
  const maxLen = Math.max(norm1.length, norm2.length);
  if (maxLen === 0) {
    return 1.0;
  }

  const distance = levenshteinDistance(norm1, norm2);
  return 1 - distance / maxLen;
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(str1: string, str2: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1, // insertion
          matrix[i - 1][j] + 1, // deletion
        );
      }
    }
  }

  return matrix[str2.length][str1.length];
}

/**
 * Store response for future similarity matching
 */
async function storeForSimilarity(
  cache: CacheManager,
  params: ModelRequestParams,
  response: ModelResponse,
): Promise<void> {
  const lastMessage = params.messages[params.messages.length - 1]?.content || "";
  const messageStart = normalizeContent(lastMessage).substring(0, 20);

  const similarityKey = {
    model: params.model,
    messageStart,
  };

  await cache.set("model-response", similarityKey, response, {
    ttl: 600, // 10 minutes
    tags: ["similarity", params.model],
  });
}
