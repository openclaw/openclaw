/**
 * ULS Module — barrel export
 */

export { UlsHub, createUlsHub, destroyUlsHub, getUlsHub } from "./hub.js";
export { sanitizeText, sanitizeObject, projectPublic, REDACTION_PATTERNS } from "./sanitize.js";
export { canWriteAtScope, canReadRecord, validateSchemaVersion } from "./policy.js";
export { UlsStore, SimpleVectorIndex, hashInput } from "./store.js";
export { formatRetrievedMemory } from "./prompt-inject.js";
export type {
  UlsConfig,
  UlsRecord,
  UlsRecordModality,
  UlsScope,
  UlsAcl,
  UlsRiskFlag,
  UlsProvenance,
  UlsContradictionMeta,
  UlsConsensusUpdate,
  UlsRetrieveQuery,
  UlsRetrieveResult,
  UlsHubApi,
} from "./types.js";
export { ULS_SCHEMA_VERSION, DEFAULT_ULS_CONFIG } from "./types.js";
