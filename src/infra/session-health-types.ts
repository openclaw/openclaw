/**
 * Session Health — Type Definitions
 *
 * These types define the raw diagnostic snapshot (Layer A) and the derived
 * operator-facing health surface (Layer B) for session lifecycle management.
 *
 * Architectural rule: `sessionHealth` is a *sibling* health domain alongside
 * existing health/heartbeat infrastructure. It does NOT live inside the
 * workflow/job state model.
 */

// ---------------------------------------------------------------------------
// Axis 1 — Session Class (identity derived from session key)
// ---------------------------------------------------------------------------

export type SessionHealthClass =
  | "main"
  | "channel"
  | "direct"
  | "cron-definition"
  | "cron-run"
  | "subagent"
  | "acp"
  | "heartbeat"
  | "thread"
  | "unknown";

// ---------------------------------------------------------------------------
// Axis 2 — Disk Artifact State (derived from filename on disk)
// ---------------------------------------------------------------------------

export type DiskArtifactState =
  | "active"
  | "deleted"
  | "reset"
  | "orphanedTemp"
  | "backup"
  | "index";

// ---------------------------------------------------------------------------
// Layer A — Raw Diagnostic Snapshot
// ---------------------------------------------------------------------------

export type SessionHealthClassCounts = Record<SessionHealthClass, number>;

export type DiskStateCounts = {
  active: number;
  deleted: number;
  reset: number;
  orphanedTemp: number;
};

export type SessionHealthStorageBreakdown = {
  totalManagedBytes: number;
  sessionsJsonBytes: number;
  activeTranscriptBytes: number;
  deletedTranscriptBytes: number;
  resetTranscriptBytes: number;
  orphanedTempBytes: number;
};

export type SessionHealthDrift = {
  indexedWithoutDiskFile: number;
  diskFilesWithoutIndex: number;
  orphanedTempCount: number;
  oldestOrphanedTempAt: string | null;
  reconciliationRecommended: boolean;
};

export type SessionHealthMaintenance = {
  mode: "warn" | "enforce";
  maxEntries: number;
  pruneAfterMs: number;
  maxDiskBytes: number | null;
  usagePercent: {
    entries: number;
    diskBytes: number | null;
  };
};

export type SessionHealthGrowth = {
  sessionsBytes24h: number | null;
  sessionsBytes7d: number | null;
  indexedCount24h: number | null;
  indexedCount7d: number | null;
};

export type SessionHealthAgentBreakdown = {
  agentId: string;
  storePath: string;
  indexedCount: number;
  byClass: SessionHealthClassCounts;
  totalManagedBytes: number;
  resetTranscriptBytes: number;
};

export type SessionHealthRawSnapshot = {
  capturedAt: string;
  collectorDurationMs: number;

  sessions: {
    indexedCount: number;
    sessionsJsonBytes: number;
    sessionsJsonParseTimeMs: number | null;
    byClass: SessionHealthClassCounts;
    /**
     * Per-class counts of sessions whose `updatedAt` exceeds the class
     * retention threshold. Only populated for prunable classes (cron-run,
     * subagent, acp, heartbeat). Null/missing values mean the class has
     * no retention policy (permanent) or no stale sessions.
     *
     * Added in the trust-fix pass to avoid overstating stale counts in
     * the remediation plan.
     */
    staleByClass?: Partial<SessionHealthClassCounts>;
    byDiskState: DiskStateCounts;
  };

  storage: SessionHealthStorageBreakdown;

  /**
   * Counts of .deleted and .reset files that are past the retention
   * window (pruneAfterMs). These allow the plan builder to report
   * honest affectedCounts rather than using the total disk-state counts,
   * which may include files still within retention.
   *
   * Added in the count-honesty fixup pass.
   */
  staleArtifacts?: {
    staleDeletedCount: number;
    staleDeletedBytes: number;
    staleResetCount: number;
    staleResetBytes: number;
  };

  drift: SessionHealthDrift;

  maintenance: SessionHealthMaintenance;

  growth: SessionHealthGrowth;

  agents: SessionHealthAgentBreakdown[];
};

// ---------------------------------------------------------------------------
// Per-Class Retention Defaults (Phase 1 taxonomy)
// ---------------------------------------------------------------------------

/**
 * Default retention thresholds per session class.
 *
 * `null` means permanent (never auto-pruned by retention policy).
 * Used by both the collector (to compute stale-per-class counts) and
 * the remediation plan builder (to determine pruning targets).
 */
export const DEFAULT_CLASS_RETENTION_MS: Record<SessionHealthClass, number | null> = {
  main: null, // permanent — never auto-pruned
  channel: null, // permanent
  direct: null, // permanent
  "cron-definition": null, // retain while cron job exists
  "cron-run": 7 * 24 * 60 * 60 * 1000, // 7 days
  subagent: 7 * 24 * 60 * 60 * 1000, // 7 days
  acp: 14 * 24 * 60 * 60 * 1000, // 14 days
  heartbeat: 3 * 24 * 60 * 60 * 1000, // 3 days
  thread: null, // inherits parent
  unknown: 30 * 24 * 60 * 60 * 1000, // 30 days (existing pruneAfterMs default)
};

// ---------------------------------------------------------------------------
// Layer B — Derived Operator-Facing Health Surface
// ---------------------------------------------------------------------------

export type SessionHealthLevel = "healthy" | "warning" | "critical" | "unknown" | "stale_data";

export type SessionHealthIndicatorKey =
  | "indexHealth"
  | "sessionPressure"
  | "storagePressure"
  | "growthTrend"
  | "stalestOrphan";

export type SessionHealthIndicator = {
  key: SessionHealthIndicatorKey;
  label: string;
  level: SessionHealthLevel;
  summary: string;
  valueText?: string | null;
  actionHint?: string | null;
  measuredAt: string;
};

export type SessionHealthSurface = {
  overallLevel: SessionHealthLevel;
  summary: string;
  indicators: SessionHealthIndicator[];
  diagnosticsAvailable: boolean;
  measuredAt: string;
  lastHealthyAt?: string | null;
};
