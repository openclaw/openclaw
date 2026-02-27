/**
 * Memory Importance Scoring (Phase 1)
 *
 * Calculates importance scores for memory chunks based on:
 * - Recency: How recently the memory was accessed
 * - Frequency: How often the memory is accessed
 * - Content type: What kind of information it contains
 */

export type ContentType = "decision" | "preference" | "fact" | "context" | "general";

export interface ImportanceParams {
  accessCount: number;
  lastAccessed: number | null;
  contentType: ContentType;
  createdAt?: number;
}

export interface ImportanceWeights {
  recency: number;
  frequency: number;
  contentType: number;
}

const DEFAULT_WEIGHTS: ImportanceWeights = {
  recency: 0.3,
  frequency: 0.3,
  contentType: 0.4,
};

const CONTENT_TYPE_SCORES: Record<ContentType, number> = {
  decision: 1.0, // Decisions are highest importance
  preference: 0.85, // User preferences matter a lot
  fact: 0.7, // Facts are useful
  context: 0.5, // Context is baseline
  general: 0.4, // General content is lower
};

// Decay constants
const RECENCY_DECAY_DAYS = 30; // Full decay over 30 days
const FREQUENCY_CAP = 10; // Cap frequency score at 10 accesses

/**
 * Calculate the importance score for a memory chunk.
 * Returns a value between 0 and 1.
 */
export function calculateImportance(
  params: ImportanceParams,
  weights: ImportanceWeights = DEFAULT_WEIGHTS,
): number {
  const now = Date.now();

  // Recency score: decays over time since last access
  let recencyScore = 0.5; // Default if never accessed
  if (params.lastAccessed) {
    const daysSinceAccess = (now - params.lastAccessed) / (1000 * 60 * 60 * 24);
    recencyScore = Math.max(0, 1 - daysSinceAccess / RECENCY_DECAY_DAYS);
  } else if (params.createdAt) {
    // If never accessed, use creation time with slower decay
    const daysSinceCreation = (now - params.createdAt) / (1000 * 60 * 60 * 24);
    recencyScore = Math.max(0.2, 1 - daysSinceCreation / (RECENCY_DECAY_DAYS * 2));
  }

  // Frequency score: more accesses = higher score, capped
  const frequencyScore = Math.min(1, params.accessCount / FREQUENCY_CAP);

  // Content type score: based on type classification
  const contentTypeScore = CONTENT_TYPE_SCORES[params.contentType] ?? 0.5;

  // Weighted combination
  const totalWeight = weights.recency + weights.frequency + weights.contentType;
  const importance =
    (recencyScore * weights.recency +
      frequencyScore * weights.frequency +
      contentTypeScore * weights.contentType) /
    totalWeight;

  // Clamp to [0, 1]
  return Math.max(0, Math.min(1, importance));
}

/**
 * Detect content type from text content.
 * Simple heuristic-based detection - can be improved with ML later.
 */
export function detectContentType(text: string): ContentType {
  const lowerText = text.toLowerCase();

  // Decision indicators
  if (
    lowerText.includes("decided") ||
    lowerText.includes("decision") ||
    lowerText.includes("chose") ||
    lowerText.includes("will do") ||
    lowerText.includes("agreed to") ||
    lowerText.includes("plan to") ||
    lowerText.includes("going to")
  ) {
    return "decision";
  }

  // Preference indicators
  if (
    lowerText.includes("prefer") ||
    lowerText.includes("like") ||
    lowerText.includes("don't like") ||
    lowerText.includes("favorite") ||
    lowerText.includes("always") ||
    lowerText.includes("never") ||
    lowerText.includes("want")
  ) {
    return "preference";
  }

  // Context (mentions of events, meetings, conversations) - check BEFORE fact
  if (
    lowerText.includes("meeting") ||
    lowerText.includes("conversation") ||
    lowerText.includes("discussed") ||
    lowerText.includes("talked about") ||
    lowerText.includes("yesterday") ||
    lowerText.includes("today") ||
    lowerText.includes("last week")
  ) {
    return "context";
  }

  // Fact indicators (specific info)
  if (
    lowerText.includes("is ") ||
    lowerText.includes("are ") ||
    lowerText.includes("was ") ||
    lowerText.includes("located") ||
    lowerText.includes("works at") ||
    lowerText.includes("lives in") ||
    /\d{4}/.test(text) || // Contains year
    /@/.test(text) || // Contains email/handle
    /\d+\.\d+\.\d+/.test(text) // Contains IP/version
  ) {
    return "fact";
  }

  return "general";
}

/**
 * Combine similarity score with importance score for final ranking.
 */
export function combineScores(
  similarity: number,
  importance: number,
  similarityWeight: number = 0.6,
  importanceWeight: number = 0.4,
): number {
  return similarity * similarityWeight + importance * importanceWeight;
}
