// Schemas
export {
  ProjectFrontmatterSchema,
  TaskFrontmatterSchema,
  QueueFrontmatterSchema,
} from "./schemas.js";

// Types
export type {
  ProjectFrontmatter,
  TaskFrontmatter,
  QueueFrontmatter,
  ParseResult,
  ParseError,
} from "./types.js";

// Errors
export { formatWarning } from "./errors.js";
export type { FrontmatterParseWarning } from "./errors.js";

// Parsers (frontmatter.ts will exist once Plan 01-02 completes)
export {
  parseProjectFrontmatter,
  parseTaskFrontmatter,
  parseQueueFrontmatter,
} from "./frontmatter.js";

// Queue
export { parseQueue } from "./queue-parser.js";
export type { QueueEntry, ParsedQueue } from "./queue-parser.js";

// Scaffold
export { ProjectManager } from "./scaffold.js";
export type { CreateProjectOpts, CreateSubProjectOpts } from "./scaffold.js";
export { generateProjectMd, generateQueueMd } from "./templates.js";

// Sync types
export type { SyncEvent, ProjectIndex, TaskIndex, BoardIndex, QueueIndex } from "./sync-types.js";

// Index generation
export {
  generateProjectIndex,
  generateTaskIndex,
  generateBoardIndex,
  generateQueueIndex,
  writeIndexFile,
  generateAllIndexes,
} from "./index-generator.js";

// Sync service
export { ProjectSyncService } from "./sync-service.js";

// Queue manager (concurrency-safe writes)
export {
  QueueManager,
  serializeQueue,
  QueueLockError,
  QueueValidationError,
  QUEUE_LOCK_OPTIONS,
} from "./queue-manager.js";
export type { QueueSection } from "./queue-manager.js";

// Capability matching
export { matchCapabilities } from "./capability-matcher.js";

// Checkpoint (interruption/resume support)
export {
  createCheckpoint,
  readCheckpoint,
  writeCheckpoint,
  checkpointPath,
} from "./checkpoint.js";
export type { CheckpointData } from "./checkpoint.js";

// Heartbeat scanner (agent task pickup)
export { scanAndClaimTask } from "./heartbeat-scanner.js";
export type { ScanAndClaimResult, ScanAndClaimOpts } from "./heartbeat-scanner.js";
