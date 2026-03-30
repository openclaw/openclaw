export type {
  ContextEngine,
  ContextEngineInfo,
  AssembleResult,
  CompactResult,
  ContextEngineMaintenanceResult,
  ContextEngineRuntimeContext,
  IngestResult,
  TranscriptRewriteReplacement,
  TranscriptRewriteRequest,
  TranscriptRewriteResult,
} from "./types.js";

export {
  registerContextEngine,
  getContextEngineFactory,
  listContextEngineIds,
  resolveContextEngine,
} from "./registry.js";
export type { ContextEngineFactory } from "./registry.js";

export { LegacyContextEngine, registerLegacyContextEngine } from "./legacy.js";
export { delegateCompactionToRuntime } from "./delegate.js";

export { ensureContextEnginesInitialized } from "./init.js";

// Context Archive for LLM-initiated compression
export {
  ContextArchive,
  createContextArchive,
  type ContextArchiveConfig,
  type ArchiveMetadata,
  type CompressContextRequest,
  type CompressContextResponse,
  type ArchiveItem,
} from "./archive.js";
