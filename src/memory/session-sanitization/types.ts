import { z } from "zod";

export const SESSION_MEMORY_CONFIDENCE_VALUES = ["high", "medium", "low"] as const;
export type SessionMemoryConfidence = (typeof SESSION_MEMORY_CONFIDENCE_VALUES)[number];

export const SESSION_MEMORY_CHILD_MODES = ["write", "recall", "signal", "mcp"] as const;
export type SessionMemoryChildMode = (typeof SESSION_MEMORY_CHILD_MODES)[number];

export type SessionMemoryRawEntry = {
  messageId: string;
  timestamp: string;
  expiresAt: string;
  transcript: string;
  body?: string;
  bodyForAgent?: string;
  from?: string;
  to?: string;
  channelId?: string;
  conversationId?: string;
  senderId?: string;
  senderName?: string;
  senderUsername?: string;
  provider?: string;
  surface?: string;
  mediaPath?: string;
  mediaType?: string;
};

export type SessionMemorySummaryEntry = {
  messageId: string;
  timestamp: string;
  rawExpiresAt: string;
  source: "transcript" | "mcp";
  decisions: string[];
  actionItems: string[];
  entities: string[];
  contextNote?: string;
  discard: boolean;
};

export type SessionMemoryAuditEvent =
  | "write"
  | "discard"
  | "write_failed"
  | "signal_failed"
  | "raw_expired"
  | "trusted_pass"
  | "structural_block"
  | "sanitized_pass"
  | "sanitized_block"
  | "mcp_raw_expired"
  // --- Input validation pipeline events (input-validation-layers-spec-v2.1) ---
  | "syntactic_pass"
  | "syntactic_fail"
  | "syntactic_flags"
  | "schema_pass"
  | "schema_fail"
  | "twopass_hard_block"
  | "frequency_escalation_tier1"
  | "frequency_escalation_tier2"
  | "frequency_escalation_tier3"
  // --- Audit trail enhancement events (audit-trail-spec-v2.1) ---
  | "rule_triggered"
  | "flags_summary"
  | "output_diff"
  | "raw_input_captured"
  | "raw_output_captured"
  | "audit_config_loaded"
  // --- Context-aware sanitization (context-aware-sanitization-spec-v2) ---
  | "context_profile_loaded";

export type SessionMemoryAuditEntry = {
  event: SessionMemoryAuditEvent;
  timestamp: string;
  messageId?: string;
  reason?: string;
  /** MCP-specific audit fields */
  server?: string;
  toolCallId?: string;
  /** Which tier produced the result: 1 (Tier 1 pre-filter) or 2 (sub-agent). */
  tier?: 1 | 2;
  flags?: string[];
  // --- Input validation pipeline fields ---
  /** Machine-readable rule IDs from syntactic filter or twopass_hard_block. */
  ruleIds?: string[];
  /** Human-readable schema violations from schema validation. */
  violations?: string[];
  /** Decayed suspicion score at time of frequency escalation event. */
  currentScore?: number;
  /** Escalation threshold that was crossed. */
  threshold?: number;
  /** Flag summaries from recent turns at time of frequency escalation. */
  recentFlags?: string[];
  // --- Audit trail enhancement fields (audit-trail-spec-v2.1) ---
  /** Which validation stage produced this entry. */
  stage?: "syntactic" | "schema" | "semantic";
  /** Single rule ID for rule_triggered events. */
  ruleId?: string;
  /** Category portion of ruleId (e.g. "injection", "schema"). */
  ruleCategory?: string;
  /** Whether the rule caused a hard block or a non-definitive flag. */
  severity?: "block" | "flag";
  /** JSON path hint indicating where in the payload the rule matched. */
  locationHint?: string;
  /** Number of flags raised in this stage (flags_summary). */
  flagCount?: number;
  /** Whether any flag in this summary resulted in a block. */
  blocked?: boolean;
  /** Active context profile at time of event (e.g. "mcp", "write"). */
  profile?: string;
  /** Structured diffs for output_diff events. */
  removals?: Array<{
    location: string;
    reason: string;
    lengthBefore: number;
    sha256: string;
  }>;
  replacements?: Array<{
    location: string;
    reason: string;
    lengthBefore: number;
    lengthAfter: number;
    sha256Before: string;
  }>;
  /** Encryption fields for raw_input_captured / raw_output_captured events. */
  encryptionKeyId?: string;
  payloadPath?: string;
  payloadSha256?: string;
  payloadBytes?: number;
  /** Audit config fields for audit_config_loaded events. */
  verbosity?: "minimal" | "standard" | "high" | "maximum";
  rawInputEnabled?: boolean;
  encryptionEnabled?: boolean;
  retentionDays?: number;
  // --- Context-aware sanitization fields (context_profile_loaded events) ---
  /** Operator context profile ID (e.g. "general", "customer-service"). */
  contextProfile?: string;
  /** True when the active profile is a custom (operator-defined) profile. */
  isCustom?: boolean;
  /** Built-in base profile for custom profiles. */
  baseProfile?: string;
  /** Resolved schema strictness at the time of context_profile_loaded. */
  schemaStrictness?: "strict" | "lenient" | { transcript: string; mcp: string };
  /** Effective audit verbosity floor from the active profile. */
  auditVerbosityFloor?: string;
  /** True when the active profile applied frequency weight overrides. */
  frequencyOverridesApplied?: boolean;
  /** Rule IDs demoted to flags-only by the profile's syntacticEmphasis.suppressRules. */
  syntacticSuppressedRules?: string[];
  /** Rule IDs added for emphasis by the profile's syntacticEmphasis.addRules. */
  syntacticAddedRules?: string[];
};

export type SessionMemoryMcpRawEntry = {
  toolCallId: string;
  timestamp: string;
  expiresAt: string;
  server: string;
  toolName: string;
  rawResult: unknown;
  sanitizedResult: unknown;
  safe: boolean;
  flags: string[];
};

export type SessionMemoryMcpChildResult = {
  mode: "mcp";
  safe: boolean;
  structuredResult: Record<string, unknown>;
  flags: string[];
  contextNote: string;
};

export type SessionMemoryWriteResult = {
  mode: "write";
  decisions: string[];
  actionItems: string[];
  entities: string[];
  contextNote?: string;
  discard: boolean;
};

export type SessionMemoryRecallChildResult = {
  mode: "recall";
  result: string;
  source: "raw" | "summary";
  matchedSummaryIds: string[];
  usedRawMessageIds: string[];
};

export type SessionMemoryRecallResult = {
  mode: "recall";
  query: string;
  result: string;
  confidence: SessionMemoryConfidence;
  source: "raw" | "summary";
};

export type SessionMemorySignalResult = {
  mode: "signal";
  relevant: string[];
  discarded?: string;
};

const stringArraySchema = z.array(z.string());

export const sessionMemoryWriteResultSchema = z
  .object({
    mode: z.literal("write"),
    decisions: stringArraySchema,
    actionItems: stringArraySchema,
    entities: stringArraySchema,
    contextNote: z.string().optional(),
    discard: z.boolean(),
  })
  .strict();

export const sessionMemoryRecallChildResultSchema = z
  .object({
    mode: z.literal("recall"),
    result: z.string(),
    source: z.enum(["raw", "summary"]),
    matchedSummaryIds: stringArraySchema,
    usedRawMessageIds: stringArraySchema,
  })
  .strict();

export const sessionMemorySignalResultSchema = z
  .object({
    mode: z.literal("signal"),
    relevant: stringArraySchema,
    discarded: z.string().optional(),
  })
  .strict();

export const sessionMemoryRawEntrySchema = z
  .object({
    messageId: z.string(),
    timestamp: z.string(),
    expiresAt: z.string(),
    transcript: z.string(),
    body: z.string().optional(),
    bodyForAgent: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    channelId: z.string().optional(),
    conversationId: z.string().optional(),
    senderId: z.string().optional(),
    senderName: z.string().optional(),
    senderUsername: z.string().optional(),
    provider: z.string().optional(),
    surface: z.string().optional(),
    mediaPath: z.string().optional(),
    mediaType: z.string().optional(),
  })
  .strict();

export const sessionMemorySummaryEntrySchema = z
  .object({
    messageId: z.string(),
    timestamp: z.string(),
    rawExpiresAt: z.string(),
    source: z.enum(["transcript", "mcp"]).default("transcript"),
    decisions: stringArraySchema,
    actionItems: stringArraySchema,
    entities: stringArraySchema,
    contextNote: z.string().optional(),
    discard: z.boolean(),
  })
  .strict();

export const sessionMemoryAuditEntrySchema = z
  .object({
    event: z.enum([
      "write",
      "discard",
      "write_failed",
      "signal_failed",
      "raw_expired",
      "trusted_pass",
      "structural_block",
      "sanitized_pass",
      "sanitized_block",
      "mcp_raw_expired",
      "syntactic_pass",
      "syntactic_fail",
      "syntactic_flags",
      "schema_pass",
      "schema_fail",
      "twopass_hard_block",
      "frequency_escalation_tier1",
      "frequency_escalation_tier2",
      "frequency_escalation_tier3",
      "rule_triggered",
      "flags_summary",
      "output_diff",
      "raw_input_captured",
      "raw_output_captured",
      "audit_config_loaded",
      "context_profile_loaded",
    ]),
    timestamp: z.string(),
    messageId: z.string().optional(),
    reason: z.string().optional(),
    server: z.string().optional(),
    toolCallId: z.string().optional(),
    tier: z.union([z.literal(1), z.literal(2)]).optional(),
    flags: z.array(z.string()).optional(),
    ruleIds: z.array(z.string()).optional(),
    violations: z.array(z.string()).optional(),
    currentScore: z.number().optional(),
    threshold: z.number().optional(),
    recentFlags: z.array(z.string()).optional(),
    stage: z.enum(["syntactic", "schema", "semantic"]).optional(),
    ruleId: z.string().optional(),
    ruleCategory: z.string().optional(),
    severity: z.enum(["block", "flag"]).optional(),
    locationHint: z.string().optional(),
    flagCount: z.number().optional(),
    blocked: z.boolean().optional(),
    profile: z.string().optional(),
    removals: z
      .array(
        z.object({
          location: z.string(),
          reason: z.string(),
          lengthBefore: z.number(),
          sha256: z.string(),
        }),
      )
      .optional(),
    replacements: z
      .array(
        z.object({
          location: z.string(),
          reason: z.string(),
          lengthBefore: z.number(),
          lengthAfter: z.number(),
          sha256Before: z.string(),
        }),
      )
      .optional(),
    encryptionKeyId: z.string().optional(),
    payloadPath: z.string().optional(),
    payloadSha256: z.string().optional(),
    payloadBytes: z.number().optional(),
    verbosity: z.enum(["minimal", "standard", "high", "maximum"]).optional(),
    rawInputEnabled: z.boolean().optional(),
    encryptionEnabled: z.boolean().optional(),
    retentionDays: z.number().optional(),
    // context_profile_loaded fields
    contextProfile: z.string().optional(),
    isCustom: z.boolean().optional(),
    baseProfile: z.string().optional(),
    schemaStrictness: z
      .union([
        z.literal("strict"),
        z.literal("lenient"),
        z.object({ transcript: z.string(), mcp: z.string() }),
      ])
      .optional(),
    auditVerbosityFloor: z.string().optional(),
    frequencyOverridesApplied: z.boolean().optional(),
    syntacticSuppressedRules: z.array(z.string()).optional(),
    syntacticAddedRules: z.array(z.string()).optional(),
  })
  .strict();

export const sessionMemoryMcpRawEntrySchema = z
  .object({
    toolCallId: z.string(),
    timestamp: z.string(),
    expiresAt: z.string(),
    server: z.string(),
    toolName: z.string(),
    rawResult: z.unknown(),
    sanitizedResult: z.unknown(),
    safe: z.boolean(),
    flags: z.array(z.string()),
  })
  .strict();

export const sessionMemoryMcpChildResultSchema = z
  .object({
    mode: z.literal("mcp"),
    safe: z.boolean(),
    structuredResult: z.record(z.string(), z.unknown()),
    flags: z.array(z.string()),
    contextNote: z.string(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Input validation pipeline types (input-validation-layers-spec-v2.1)
// ---------------------------------------------------------------------------

/** Result of Stage 1A syntactic pre-filter (pure function, no model call). */
export type SyntacticFilterResult = {
  /** True when no patterns triggered a definitive block. */
  pass: boolean;
  /** Human-readable descriptions of each triggered pattern. */
  flags: string[];
  /** Machine-readable rule IDs from RULE_TAXONOMY for each trigger. */
  ruleIds: string[];
};

/** Result of Stage 1B schema validation (pure function, no model call). */
export type SchemaValidationResult = {
  /** True when the input matches its declared schema. */
  pass: boolean;
  /** Human-readable description of each violation. */
  violations: string[];
  /** Machine-readable rule IDs (schema.missing-field, schema.type-mismatch, schema.extra-field). */
  ruleIds: string[];
};

/** Merged result of parallel Stage 1A + 1B execution. */
export type PreFilterResult = {
  syntactic: SyntacticFilterResult;
  schema: SchemaValidationResult;
  /** True only when both syntactic and schema checks pass. */
  pass: boolean;
  /** Rule IDs merged from both results. */
  allRuleIds: string[];
  /** Flags merged from both results. */
  allFlags: string[];
};

/**
 * Per-session frequency tracking state. Two floats only — O(1) storage.
 * Held in memory for session lifetime; not persisted.
 */
export type SessionSuspicionState = {
  lastScore: number;
  lastUpdateMs: number;
  /** Set to true on Tier 3 escalation; all subsequent calls are immediately blocked. */
  terminated?: boolean;
};

/** Escalation tier for within-session frequency tracking. */
export type EscalationTier = "none" | "tier1" | "tier2" | "tier3";

/**
 * Declared output schema for MCP tool validation (Stage 1B).
 * Tools returning polymorphic responses should use discriminated unions.
 */
export type ToolOutputSchema = {
  /** Field name acting as the discriminant (e.g. "type", "status"). */
  discriminant?: string;
  /** Variant name → field name → expected type string (for discriminated unions). */
  variants?: Record<string, Record<string, string>>;
  /** Single-schema fallback for non-union tools. */
  fields?: Record<string, string>;
};

/** Verbosity tier for the audit trail. Higher tiers include all lower-tier events. */
export type AuditVerbosity = "minimal" | "standard" | "high" | "maximum";

// ---------------------------------------------------------------------------
// Rule taxonomy (audit-trail-spec-v2.1)
//
// Versioned, immutable constant. MUST NOT be loaded from config — defining
// this in code prevents config-injection attacks on the filter itself.
// Update via code change + PR, not via runtime config.
// ---------------------------------------------------------------------------

export type RuleTaxonomyEntry = {
  category: string;
  stage: "syntactic" | "schema" | "semantic";
};

export const RULE_TAXONOMY: Readonly<Record<string, RuleTaxonomyEntry>> = Object.freeze({
  "injection.ignore-previous": { category: "injection", stage: "syntactic" },
  "injection.system-override": { category: "injection", stage: "syntactic" },
  "injection.role-switch-capability": {
    category: "injection",
    stage: "syntactic",
  },
  "injection.role-switch-only": { category: "injection", stage: "semantic" },
  "injection.direct-address": { category: "injection", stage: "semantic" },
  "credential.api-key-pattern": { category: "credential", stage: "semantic" },
  "credential.password-pattern": { category: "credential", stage: "semantic" },
  "credential.env-var-pattern": { category: "credential", stage: "semantic" },
  "scope-creep.permission-escalation": {
    category: "scope-creep",
    stage: "semantic",
  },
  "scope-creep.cross-agent-reference": {
    category: "scope-creep",
    stage: "semantic",
  },
  "structural.oversized-payload": { category: "structural", stage: "syntactic" },
  "structural.excessive-depth": { category: "structural", stage: "syntactic" },
  "structural.encoding-trick": { category: "structural", stage: "syntactic" },
  "structural.binary-content": { category: "structural", stage: "syntactic" },
  "schema.missing-field": { category: "schema", stage: "schema" },
  "schema.undeclared-admin-reject": { category: "schema", stage: "schema" },
  "schema.type-mismatch": { category: "schema", stage: "schema" },
  "schema.extra-field": { category: "schema", stage: "schema" },
  "semantic.safe-false": { category: "semantic", stage: "semantic" },
  "semantic.low-confidence": { category: "semantic", stage: "semantic" },
  "semantic.malformed-output": { category: "semantic", stage: "semantic" },
});

// ---------------------------------------------------------------------------
// Alert payload (audit-alerting-spec-v2.1)
// ---------------------------------------------------------------------------

/** A single audit event record as read from a session JSONL (with context fields). */
export type AuditEventRecord = SessionMemoryAuditEntry & {
  agentId: string;
  sessionId: string;
};

export type AlertSeverity = "info" | "low" | "medium" | "high" | "critical";

export type AlertPayload = {
  /** Unique identifier for deduplication (ruleId + agentId + sessionId + window). */
  alertId: string;
  /** Which alert rule fired (e.g. "syntacticFailBurst"). */
  ruleId: string;
  severity: AlertSeverity;
  agentId: string;
  /** Null for cross-session aggregation alerts. */
  sessionId: string | null;
  timestamp: string;
  /** Human-readable one-line description. */
  summary: string;
  details: {
    triggeringEvents: AuditEventRecord[];
    /** Last N events from same session (capped by alerting.payload.recentContextMax). */
    recentContext: AuditEventRecord[];
    sessionSuspicionScore?: number;
  };
  metadata: {
    ruleConfig: Record<string, unknown>;
    suppressedCount?: number;
  };
};
