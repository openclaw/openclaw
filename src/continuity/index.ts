export {
  CONTINUITY_FILE_BY_KIND,
  CONTINUITY_KIND_ORDER,
  DEFAULT_CONTINUITY_CONFIG,
  resolveContinuityConfig,
} from "./config.js";
export { extractContinuityMatches } from "./extractor.js";
export { ContinuityContextEngine } from "./engine.js";
export { classifyContinuitySource, isContinuityScopeAllowed } from "./scope.js";
export { ContinuityService, createContinuityService } from "./service.js";
export { registerContinuityCli } from "./cli.js";
export type {
  ContinuityCandidate,
  ContinuityCaptureConfig,
  ContinuityCaptureInput,
  ContinuityCaptureMode,
  ContinuityExplainResult,
  ContinuityExtractionMatch,
  ContinuityItem,
  ContinuityKind,
  ContinuityListFilters,
  ContinuityPatchAction,
  ContinuityPatchResult,
  ContinuityPending,
  ContinuityPluginConfig,
  ContinuityRecallConfig,
  ContinuityRecord,
  ContinuityRejected,
  ContinuityReviewConfig,
  ContinuityReviewState,
  ContinuitySource,
  ContinuitySourceClass,
  ContinuityStatus,
  ContinuityStoreFile,
  ResolvedContinuityConfig,
} from "./types.js";
