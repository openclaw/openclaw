/**
 * Drizzle ORM schema definitions for OpenClaw PostgreSQL/TimescaleDB tables.
 *
 * These mirror the existing raw SQL migrations (client.ts + humanization managers).
 * TimescaleDB features (hypertables, continuous aggregates) are handled via custom
 * SQL migrations — Drizzle doesn't support them natively.
 */

import {
  boolean,
  decimal,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Core: migrations tracking
// ---------------------------------------------------------------------------

export const migrations = pgTable("migrations", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Core: LLM usage metrics (TimescaleDB hypertable)
// ---------------------------------------------------------------------------

export const llmUsage = pgTable(
  "llm_usage",
  {
    time: timestamp("time", { withTimezone: true }).notNull(),
    providerId: text("provider_id").notNull(),
    modelId: text("model_id").notNull(),
    agentId: text("agent_id"),
    sessionId: text("session_id"),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens").default(0),
    cacheWriteTokens: integer("cache_write_tokens").default(0),
    costUsd: decimal("cost_usd", { precision: 10, scale: 6 }),
    durationMs: integer("duration_ms"),
  },
  (t) => [
    index("idx_usage_provider").on(t.providerId, t.time),
    index("idx_usage_model").on(t.modelId, t.time),
    index("idx_usage_agent").on(t.agentId, t.time),
    index("idx_usage_session").on(t.sessionId, t.time),
  ],
);

// ---------------------------------------------------------------------------
// Core: Security events (TimescaleDB hypertable)
// ---------------------------------------------------------------------------

export const securityEvents = pgTable(
  "security_events",
  {
    time: timestamp("time", { withTimezone: true }).notNull(),
    eventId: text("event_id").notNull(),
    category: text("category").notNull(),
    severity: text("severity").notNull(),
    action: text("action").notNull(),
    description: text("description"),
    source: text("source"),
    sessionKey: text("session_key"),
    agentId: text("agent_id"),
    userId: text("user_id"),
    ipAddress: text("ip_address"),
    channel: text("channel"),
    blocked: boolean("blocked").default(false),
    metadata: jsonb("metadata"),
  },
  (t) => [
    primaryKey({ columns: [t.time, t.eventId] }),
    index("idx_security_category").on(t.category, t.time),
    index("idx_security_severity").on(t.severity, t.time),
    index("idx_security_session").on(t.sessionKey, t.time),
    index("idx_security_ip").on(t.ipAddress, t.time),
  ],
);

// ---------------------------------------------------------------------------
// Humanization: agent memory
// ---------------------------------------------------------------------------

export const agentMemory = pgTable(
  "agent_memory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: text("agent_id").notNull(),
    memoryType: text("memory_type").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    context: jsonb("context").default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    importance: integer("importance").notNull().default(5),
    retentionScore: decimal("retention_score", { precision: 3, scale: 2 }).notNull().default("1.0"),
  },
  (t) => [
    index("idx_memory_agent_created").on(t.agentId, t.createdAt),
    index("idx_memory_agent_importance").on(t.agentId, t.importance),
    index("idx_memory_type").on(t.memoryType),
  ],
);

// ---------------------------------------------------------------------------
// Humanization: agent relationships
// ---------------------------------------------------------------------------

export const agentRelationships = pgTable(
  "agent_relationships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: text("agent_id").notNull(),
    otherAgentId: text("other_agent_id").notNull(),
    trustScore: decimal("trust_score", { precision: 3, scale: 2 }).notNull().default("0.5"),
    collaborationQuality: text("collaboration_quality").notNull().default("unknown"),
    interactionCount: integer("interaction_count").notNull().default(0),
    positiveInteractions: integer("positive_interactions").notNull().default(0),
    negativeInteractions: integer("negative_interactions").notNull().default(0),
    lastInteraction: timestamp("last_interaction", { withTimezone: true }),
    notes: text("notes"),
  },
  (t) => [
    index("idx_relationships_agent_trust").on(t.agentId, t.trustScore),
    index("idx_relationships_pair").on(t.agentId, t.otherAgentId),
  ],
);

// ---------------------------------------------------------------------------
// Humanization: agent reputation
// ---------------------------------------------------------------------------

export const agentReputation = pgTable(
  "agent_reputation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: text("agent_id").notNull().unique(),
    reliabilityScore: decimal("reliability_score", { precision: 3, scale: 2 })
      .notNull()
      .default("0.5"),
    speedRating: text("speed_rating").notNull().default("unknown"),
    qualityRating: text("quality_rating").notNull().default("unknown"),
    accountabilityScore: decimal("accountability_score", { precision: 3, scale: 2 })
      .notNull()
      .default("0.5"),
    communicationScore: decimal("communication_score", { precision: 3, scale: 2 })
      .notNull()
      .default("0.5"),
    collaborationScore: decimal("collaboration_score", { precision: 3, scale: 2 })
      .notNull()
      .default("0.5"),
    trend: text("trend").notNull().default("stable"),
    lastUpdated: timestamp("last_updated", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_reputation_agent").on(t.agentId),
    index("idx_reputation_reliability").on(t.reliabilityScore),
    index("idx_reputation_quality").on(t.qualityRating),
    index("idx_reputation_trend").on(t.trend),
  ],
);

// ---------------------------------------------------------------------------
// Humanization: agent track record
// ---------------------------------------------------------------------------

export const agentTrackRecord = pgTable(
  "agent_track_record",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: text("agent_id").notNull(),
    taskId: text("task_id").notNull(),
    taskName: text("task_name"),
    category: text("category"),
    plannedDays: integer("planned_days"),
    actualDays: integer("actual_days"),
    qualityRating: text("quality_rating"),
    deliveredStatus: text("delivered_status"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    notes: text("notes"),
  },
  (t) => [
    index("idx_track_agent_completed").on(t.agentId, t.completedAt),
    index("idx_track_status").on(t.deliveredStatus),
  ],
);

// ---------------------------------------------------------------------------
// Humanization: agent decision log (TimescaleDB hypertable)
// ---------------------------------------------------------------------------

export const agentDecisionLog = pgTable(
  "agent_decision_log",
  {
    time: timestamp("time", { withTimezone: true }).notNull(),
    agentId: text("agent_id").notNull(),
    decisionType: text("decision_type").notNull(),
    decisionQuality: text("decision_quality").notNull(),
    outcome: text("outcome"),
    confidenceLevel: integer("confidence_level"),
    impactScore: decimal("impact_score", { precision: 3, scale: 2 }),
    context: jsonb("context").default({}),
  },
  (t) => [
    index("idx_decision_agent_time").on(t.agentId, t.time),
    index("idx_decision_agent_quality").on(t.agentId, t.decisionQuality, t.time),
    index("idx_decision_agent_type").on(t.agentId, t.decisionType, t.time),
  ],
);

// ---------------------------------------------------------------------------
// Humanization: agent autonomy config
// ---------------------------------------------------------------------------

export const agentAutonomyConfig = pgTable(
  "agent_autonomy_config",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: text("agent_id").notNull(),
    riskLevel: text("risk_level").notNull(),
    definition: text("definition").notNull(),
    autonomyType: text("autonomy_type").notNull(),
    conditions: jsonb("conditions").default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_autonomy_agent").on(t.agentId), index("idx_autonomy_risk").on(t.riskLevel)],
);

// ---------------------------------------------------------------------------
// Humanization: agent intuition rules
// ---------------------------------------------------------------------------

export const agentIntuitionRules = pgTable(
  "agent_intuition_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: text("agent_id").notNull(),
    patternName: text("pattern_name").notNull(),
    patternDescription: text("pattern_description"),
    triggerConditions: jsonb("trigger_conditions").default({}),
    recommendedAction: text("recommended_action"),
    actionConfidence: decimal("action_confidence", { precision: 3, scale: 2 })
      .notNull()
      .default("0.5"),
    timesTriggered: integer("times_triggered").notNull().default(0),
    timesCorrect: integer("times_correct").notNull().default(0),
    accuracyRate: decimal("accuracy_rate", { precision: 3, scale: 2 }).notNull().default("0.0"),
  },
  (t) => [
    index("idx_intuition_agent_accuracy").on(t.agentId, t.accuracyRate),
    index("idx_intuition_agent_triggered").on(t.agentId, t.timesTriggered),
  ],
);

// ---------------------------------------------------------------------------
// Humanization: agent energy state
// ---------------------------------------------------------------------------

export const agentEnergyState = pgTable(
  "agent_energy_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: text("agent_id").notNull().unique(),
    currentHour: text("current_hour"),
    energyLevel: decimal("energy_level", { precision: 3, scale: 2 }).notNull().default("0.5"),
    focusLevel: decimal("focus_level", { precision: 3, scale: 2 }).notNull().default("0.5"),
    contextSwitchesToday: integer("context_switches_today").notNull().default(0),
    deepWorkMinutes: integer("deep_work_minutes").notNull().default(0),
    lastBreak: timestamp("last_break", { withTimezone: true }),
    qualityVariance: decimal("quality_variance", { precision: 3, scale: 2 })
      .notNull()
      .default("0.0"),
    lastUpdated: timestamp("last_updated", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_energy_agent").on(t.agentId)],
);

// ---------------------------------------------------------------------------
// Humanization: agent mistake patterns
// ---------------------------------------------------------------------------

export const agentMistakePatterns = pgTable(
  "agent_mistake_patterns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: text("agent_id").notNull(),
    mistakeType: text("mistake_type").notNull(),
    description: text("description"),
    occurrences: integer("occurrences").notNull().default(1),
    lastOccurrence: timestamp("last_occurrence", { withTimezone: true }),
    recommendedAction: text("recommended_action"),
    fixApplied: boolean("fix_applied").default(false),
  },
  (t) => [
    index("idx_mistakes_agent_occurrences").on(t.agentId, t.occurrences),
    index("idx_mistakes_agent_last").on(t.agentId, t.lastOccurrence),
  ],
);

// ---------------------------------------------------------------------------
// Auth: encrypted credentials (centralized auth store)
// ---------------------------------------------------------------------------

export const authCredentials = pgTable(
  "auth_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profileId: text("profile_id").notNull().unique(),
    provider: text("provider").notNull(),
    credentialType: text("credential_type").notNull(), // "api_key" | "token" | "oauth"
    encryptedData: text("encrypted_data").notNull(), // AES-256-GCM ciphertext (JSON blob)
    iv: text("iv").notNull(), // unique per encryption
    authTag: text("auth_tag").notNull(), // GCM authentication tag
    keyVersion: integer("key_version").notNull().default(1),
    email: text("email"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_auth_creds_provider").on(t.provider),
    index("idx_auth_creds_type").on(t.credentialType),
    index("idx_auth_creds_expires").on(t.expiresAt),
  ],
);

export const authUsageStats = pgTable(
  "auth_usage_stats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profileId: text("profile_id")
      .notNull()
      .unique()
      .references(() => authCredentials.profileId, { onDelete: "cascade" }),
    lastUsed: timestamp("last_used", { withTimezone: true }),
    errorCount: integer("error_count").default(0),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    failureCounts: jsonb("failure_counts").default({}),
    cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
    disabledUntil: timestamp("disabled_until", { withTimezone: true }),
    disabledReason: text("disabled_reason"),
  },
  (t) => [index("idx_auth_usage_profile").on(t.profileId)],
);

export const authStoreMeta = pgTable("auth_store_meta", {
  key: text("key").primaryKey(), // "order", "lastGood"
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// ---------------------------------------------------------------------------
// Schema metadata (for version tracking)
// ---------------------------------------------------------------------------

export const schemaMeta = pgTable("schema_meta", {
  key: text("key").primaryKey(),
  value: text("value"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});
