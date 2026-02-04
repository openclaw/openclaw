/**
 * Types for the Progressive Memory System.
 *
 * These types define the structured memory store that supplements (not replaces)
 * the existing MEMORY.md + memory_search / memory_get system.
 */

/** Memory entry categories for structured storage. */
export type MemoryCategory =
  | "preference"
  | "instruction"
  | "fact"
  | "project"
  | "person"
  | "decision"
  | "insight";

/** Priority tiers controlling context budget allocation. */
export type MemoryPriority = "critical" | "high" | "medium" | "low";

/** Source tracking for memory entries. */
export type MemorySource = "session" | "manual" | "migration" | "consolidation";

/**
 * A structured memory entry in the progressive store.
 */
export type ProgressiveMemoryEntry = {
  id: string;
  category: MemoryCategory;
  content: string;
  context?: string;
  priority: MemoryPriority;
  tags: string[];
  relatedTo: string[];
  source: MemorySource;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  expiresAt?: string; // ISO 8601
  tokenEstimate: number;
  archived: boolean;
};

/**
 * Parameters for storing a new memory entry.
 */
export type MemoryStoreParams = {
  category: MemoryCategory;
  content: string;
  context?: string;
  priority?: MemoryPriority;
  tags?: string[];
  relatedTo?: string[];
  source?: MemorySource;
  expires?: string; // ISO 8601
};

/**
 * Result of a store operation.
 */
export type MemoryStoreResult = {
  id: string;
  category: MemoryCategory;
  stored: boolean;
  deduplicated: boolean;
  mergedWithId?: string;
  tokenCost: number;
};

/**
 * Parameters for recalling memories.
 */
export type MemoryRecallParams = {
  query: string;
  categories?: MemoryCategory[];
  priorityMin?: MemoryPriority;
  tokenBudget?: number;
  includeContext?: boolean;
  format?: "brief" | "detailed";
};

/**
 * A scored memory entry from recall.
 */
export type MemoryRecallEntry = {
  id: string;
  category: MemoryCategory;
  content: string;
  context?: string;
  priority: MemoryPriority;
  score: number;
  storedAt: string;
  tags: string[];
};

/**
 * Result of a recall operation.
 */
export type MemoryRecallResult = {
  entries: MemoryRecallEntry[];
  tokenCount: number;
  budgetRemaining: number;
  totalEntriesMatched: number;
};

/**
 * Status information for the progressive memory system.
 */
export type ProgressiveMemoryStatus = {
  totalEntries: number;
  byCategory: Record<MemoryCategory, number>;
  byPriority: Record<MemoryPriority, number>;
  totalTokensEstimated: number;
  lastStore?: string;
  lastRecall?: string;
  domainFiles: string[];
  dbPath: string;
  vectorEnabled: boolean;
  ftsEnabled: boolean;
};

/**
 * Audit analysis result.
 */
export type MemoryAuditBreakdown = {
  source: string;
  tokens: number;
  percentage: number;
  category: string;
};

export type MemoryAuditDuplicate = {
  contentA: string;
  contentB: string;
  similarity: number;
  sources: string[];
};

export type MemoryAuditRecommendation = {
  action: string;
  description: string;
  estimatedSavingsTokens: number;
  risk: "low" | "medium" | "high";
};

export type MemoryAuditResult = {
  analysis: {
    totalTokens: number;
    breakdown: MemoryAuditBreakdown[];
    duplicates: MemoryAuditDuplicate[];
  };
  recommendations?: MemoryAuditRecommendation[];
};

/** Priority ordering for comparisons (higher number = higher priority). */
export const PRIORITY_ORDER: Record<MemoryPriority, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/** Valid categories set for validation. */
export const VALID_CATEGORIES: ReadonlySet<string> = new Set<MemoryCategory>([
  "preference",
  "instruction",
  "fact",
  "project",
  "person",
  "decision",
  "insight",
]);

/** Valid priorities set for validation. */
export const VALID_PRIORITIES: ReadonlySet<string> = new Set<MemoryPriority>([
  "critical",
  "high",
  "medium",
  "low",
]);
