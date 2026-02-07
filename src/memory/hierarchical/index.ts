/**
 * Hierarchical Memory System
 *
 * A 2048-style compression system for long-running conversations.
 * Continuously summarizes conversation chunks in the background,
 * creating layers of progressively compressed context.
 *
 * See: docs/plans/hierarchical-memory.md
 */

// Types
export {
  type HierarchicalMemoryConfig,
  type SummaryEntry,
  type SummaryIndex,
  type SummaryLevel,
  DEFAULT_HIERARCHICAL_MEMORY_CONFIG,
  createEmptyIndex,
  getAllSummariesForContext,
  getUnmergedSummaries,
} from "./types.js";

// Config
export { isHierarchicalMemoryEnabled, resolveHierarchicalMemoryConfig } from "./config.js";

// Storage
export {
  ensureSummariesDir,
  extractSummaryContent,
  hasSummaries,
  loadSummaryContents,
  loadSummaryIndex,
  readSummary,
  resolveIndexPath,
  resolveLevelDir,
  resolveSummariesDir,
  resolveSummaryPath,
  saveSummaryIndex,
  writeSummary,
  generateNextSummaryId,
} from "./storage.js";

// Locking
export { acquireSummaryLock, isLockHeld, type WorkerLock } from "./lock.js";

// Prompts
export {
  buildChunkSummarizationPrompt,
  buildMergeSummariesPrompt,
  formatMessagesForSummary,
  MERGE_SUMMARIES_SYSTEM,
  SUMMARIZE_CHUNK_SYSTEM,
} from "./prompts.js";

// Summarization
export {
  estimateMessagesTokens,
  getNextLevel,
  getSourceLevel,
  mergeSummaries,
  summarizeChunk,
  type ChunkToSummarize,
  type SummarizationParams,
} from "./summarize.js";

// Worker
export { runHierarchicalMemoryWorker, type WorkerResult } from "./worker.js";

// Context injection
export {
  getLastSummarizedEntryId,
  getMemoryStats,
  hasMemoryData,
  loadMemoryContext,
  type MemoryContext,
} from "./context.js";

// Timer
export { startHierarchicalMemoryTimer, type HierarchicalMemoryTimerHandle } from "./timer.js";
