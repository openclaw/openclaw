/**
 * Observability ingestion pipeline.
 *
 * Watches OpenClaw's log files and ingests them into SQLite for analysis.
 *
 * Data sources:
 * - Session logs: ~/.openclaw/agents/*\/sessions\/*.jsonl
 * - Cache trace: ~/.openclaw/logs/cache-trace.jsonl
 * - System logs: /tmp/openclaw/openclaw-*.log
 *
 * Database: ~/.openclaw/observability.db
 *
 * @example
 * ```ts
 * import { createIngestor } from "./observability/index.js";
 *
 * const ingestor = createIngestor();
 *
 * // One-time ingestion
 * const result = await ingestor.ingestExisting();
 * console.log(`Ingested ${result.events} events from ${result.files} files`);
 *
 * // Watch mode (continuous ingestion)
 * await ingestor.startWatching();
 *
 * // Get status
 * const status = ingestor.status();
 * console.log(status);
 *
 * // Cleanup
 * await ingestor.close();
 * ```
 */

// Main ingestor
export {
  ObservabilityIngestor,
  createIngestor,
  getDefaultWatchedPaths,
  type IngestorOptions,
} from "./ingestor.js";

// Schema utilities
export {
  ensureObservabilitySchema,
  getTrackedFile,
  insertEventsBatch,
  updateTrackedFile,
} from "./schema.js";

// Tail reader
export { readLogSlice, readNewLines, type TailReadResult } from "./tail-reader.js";

// Watcher
export {
  createWatcher,
  resolveWatchedFiles,
  type FileChangeCallback,
  type FileChangeEvent,
  type WatchedPath,
  type WatcherOptions,
} from "./watcher.js";

// Parsers
export {
  PARSERS,
  getParser,
  parseLines,
  parseCacheTraceLine,
  parseSessionLine,
  parseSystemLogLine,
  cacheTraceParser,
  sessionParser,
  systemLogParser,
  type LogParser,
  type ParsedEvent,
  type SourceType,
} from "./parsers/index.js";

// Synthetic fixtures for QA and tests
export {
  buildSyntheticObservabilityDataset,
  writeSyntheticObservabilityFiles,
  type SyntheticDatasetOptions,
  type SyntheticObservabilityDataset,
} from "./synthetic-data.js";
