/**
 * ULS (Unified Latent Space) Record & API Types
 *
 * Defines the versioned record model, projection types, scope/ACL,
 * and internal API surface for cross-agent shared memory.
 */

// ---------------------------------------------------------------------------
// Record model (schema version 1)
// ---------------------------------------------------------------------------

export const ULS_SCHEMA_VERSION = 1;

export type UlsRecordModality =
  | "tool_result"
  | "user_msg"
  | "system_event"
  | "plan_step"
  | "contradiction";

export type UlsScope = "self" | "team" | "global";

export type UlsAcl = {
  allow?: string[]; // agent IDs or group names
  deny?: string[]; // agent IDs or group names
};

export type UlsRiskFlag =
  | "injection_suspect"
  | "poisoning_suspect"
  | "credential_leak"
  | "pii_detected"
  | "excessive_length";

export type UlsProvenance = {
  sourceTool?: string;
  sourceChannel?: string;
  inputHash: string; // SHA-256 of the raw input, bounded
};

export type UlsRecord = {
  schemaVersion: number;
  recordId: string; // UUID v4
  agentId: string;
  timestamp: number; // epoch ms
  modality: UlsRecordModality;
  /** Structured state summary (redacted). Never contains raw secrets. */
  ut: Record<string, unknown>;
  /** Private latent — never retrievable cross-agent; encrypted at rest. */
  zPrivate?: string; // base64-encoded, optional
  /** Public projection — safe to share per policy. */
  pPublic: Record<string, unknown>;
  tags: string[];
  riskFlags: UlsRiskFlag[];
  scope: UlsScope;
  acl: UlsAcl;
  provenance: UlsProvenance;
};

// ---------------------------------------------------------------------------
// Contradiction record extension
// ---------------------------------------------------------------------------

export type UlsContradictionMeta = {
  contradictionType: "policy_denial" | "tool_failure" | "conflicting_instructions" | "value_drift";
  tensionScore?: number; // 0–1
  parties?: string[]; // agent IDs or entity names
  synthesisHint?: string;
};

// ---------------------------------------------------------------------------
// Query / retrieval types
// ---------------------------------------------------------------------------

export type UlsRetrieveQuery = {
  agentId: string;
  query: string;
  scope: UlsScope;
  topK?: number;
  tags?: string[];
};

export type UlsRetrieveResult = {
  records: Array<{
    recordId: string;
    agentId: string;
    timestamp: number;
    modality: UlsRecordModality;
    pPublic: Record<string, unknown>;
    tags: string[];
    riskFlags: UlsRiskFlag[];
    provenance: UlsProvenance;
    similarityScore?: number;
  }>;
};

// ---------------------------------------------------------------------------
// Consensus stub types
// ---------------------------------------------------------------------------

export type UlsConsensusUpdate = {
  proposalId: string;
  agentId: string;
  vote: "approve" | "reject" | "abstain";
  rationale?: string;
};

// ---------------------------------------------------------------------------
// Hub configuration
// ---------------------------------------------------------------------------

export type UlsConfig = {
  enabled: boolean;
  storagePath: string;
  indexType: "simple" | "faiss";
  maxInjectionTokens: number;
  allowedScopes: Record<string, UlsScope[]>; // agentId -> allowed scopes
  teamGroups: Record<string, string[]>; // group name -> agent IDs
  encryptionKey?: string; // for z_private at-rest encryption
};

export const DEFAULT_ULS_CONFIG: UlsConfig = {
  enabled: false,
  storagePath: "",
  indexType: "simple",
  maxInjectionTokens: 2048,
  allowedScopes: {},
  teamGroups: {},
};

// ---------------------------------------------------------------------------
// Internal Hub API interface
// ---------------------------------------------------------------------------

export type UlsHubApi = {
  encode(ut: Record<string, unknown>, agentId: string): Promise<UlsRecord>;
  project(record: UlsRecord): Record<string, unknown>;
  store(record: UlsRecord): Promise<void>;
  retrieve(query: UlsRetrieveQuery): Promise<UlsRetrieveResult>;
  consensusUpdate(update: UlsConsensusUpdate): Promise<void>;
  contradictionUpdate(
    agentId: string,
    meta: UlsContradictionMeta,
    ut: Record<string, unknown>,
  ): Promise<void>;
  close(): Promise<void>;
};
