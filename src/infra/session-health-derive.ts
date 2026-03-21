/**
 * Session Health — Layer B Derivation Logic
 *
 * Pure functions that transform a raw `SessionHealthRawSnapshot` (Layer A)
 * into a compact `SessionHealthSurface` (Layer B) suitable for Mission Control.
 *
 * Design principles:
 * - Health STATES over raw counts (~5 indicators, each with a level)
 * - Thresholds are usage-relative where possible, not brittle absolutes
 * - `stale_data` overrides when the snapshot is too old to trust
 * - `unknown` for indicators that lack sufficient data (e.g., growth before 24h of history)
 * - No cleanup/remediation logic — this is visibility only
 */

import type {
  SessionHealthIndicator,
  SessionHealthIndicatorKey,
  SessionHealthLevel,
  SessionHealthRawSnapshot,
  SessionHealthSurface,
} from "./session-health-types.js";

// ---------------------------------------------------------------------------
// Thresholds (tunable constants, not yet user-configurable)
// ---------------------------------------------------------------------------

/** How old a snapshot can be before we mark the entire surface stale. */
const STALE_SNAPSHOT_MS = 15 * 60 * 1000; // 15 minutes (3× the default 5-min interval)

// Index Health
const INDEX_DRIFT_WARN = 3;
const INDEX_DRIFT_CRITICAL = 10;

// Session Pressure (percentage of maxEntries)
const SESSION_PRESSURE_WARN_PCT = 60;
const SESSION_PRESSURE_CRITICAL_PCT = 85;

// Storage Pressure
const STORAGE_PRESSURE_WARN_PCT = 60;
const STORAGE_PRESSURE_CRITICAL_PCT = 85;
// Absolute fallbacks when no disk budget is configured
const STORAGE_ABSOLUTE_WARN_BYTES = 500 * 1024 * 1024; // 500 MB
const STORAGE_ABSOLUTE_CRITICAL_BYTES = 1024 * 1024 * 1024; // 1 GB
// Reset transcript bloat threshold (% of total managed bytes)
const RESET_BLOAT_WARN_PCT = 50;

// Growth Trend (% of current indexed count, 24h window)
const GROWTH_24H_WARN_PCT = 5;
const GROWTH_24H_CRITICAL_PCT = 15;
const GROWTH_7D_WARN_PCT = 50;

// Stalest Orphan
const _ORPHAN_WARN_AGE_MS = 60 * 60 * 1000; // 1 hour (reserved for future threshold refinement)
const ORPHAN_CRITICAL_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function indicator(
  key: SessionHealthIndicatorKey,
  label: string,
  level: SessionHealthLevel,
  summary: string,
  measuredAt: string,
  opts?: { valueText?: string; actionHint?: string },
): SessionHealthIndicator {
  return {
    key,
    label,
    level,
    summary,
    valueText: opts?.valueText ?? null,
    actionHint: opts?.actionHint ?? null,
    measuredAt,
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) {
    return `${Math.round(ms / 1000)}s`;
  }
  if (ms < 3_600_000) {
    return `${Math.round(ms / 60_000)}m`;
  }
  if (ms < 86_400_000) {
    return `${(ms / 3_600_000).toFixed(1)}h`;
  }
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

// ---------------------------------------------------------------------------
// Individual indicator derivers
// ---------------------------------------------------------------------------

export function deriveIndexHealth(snapshot: SessionHealthRawSnapshot): SessionHealthIndicator {
  const { drift } = snapshot;
  const totalDrift = drift.indexedWithoutDiskFile + drift.diskFilesWithoutIndex;

  if (totalDrift === 0 && drift.orphanedTempCount === 0) {
    return indicator(
      "indexHealth",
      "Index Health",
      "healthy",
      "No drift detected",
      snapshot.capturedAt,
    );
  }

  const parts: string[] = [];
  if (drift.indexedWithoutDiskFile > 0) {
    parts.push(`${drift.indexedWithoutDiskFile} index entries without disk file`);
  }
  if (drift.diskFilesWithoutIndex > 0) {
    parts.push(`${drift.diskFilesWithoutIndex} disk files without index entry`);
  }
  if (drift.orphanedTempCount > 0) {
    parts.push(
      `${drift.orphanedTempCount} orphaned temp file${drift.orphanedTempCount > 1 ? "s" : ""}`,
    );
  }
  const summary = parts.join("; ");

  if (totalDrift > INDEX_DRIFT_CRITICAL || drift.reconciliationRecommended) {
    return indicator("indexHealth", "Index Health", "critical", summary, snapshot.capturedAt, {
      valueText: `${totalDrift} drift entries`,
      actionHint: "Run index reconciliation",
    });
  }

  if (totalDrift > INDEX_DRIFT_WARN || drift.orphanedTempCount > 0) {
    return indicator("indexHealth", "Index Health", "warning", summary, snapshot.capturedAt, {
      valueText: `${totalDrift} drift entries`,
    });
  }

  // Low drift, below warning threshold
  return indicator("indexHealth", "Index Health", "healthy", "Minimal drift", snapshot.capturedAt, {
    valueText: `${totalDrift} drift entries`,
  });
}

export function deriveSessionPressure(snapshot: SessionHealthRawSnapshot): SessionHealthIndicator {
  const { sessions, maintenance } = snapshot;
  const pct = maintenance.usagePercent.entries;
  const count = sessions.indexedCount;
  const max = maintenance.maxEntries;
  const valueText = `${count} / ${max} (${pct.toFixed(0)}%)`;

  if (pct >= SESSION_PRESSURE_CRITICAL_PCT) {
    return indicator(
      "sessionPressure",
      "Session Pressure",
      "critical",
      `Session index at ${pct.toFixed(0)}% capacity`,
      snapshot.capturedAt,
      { valueText, actionHint: "Consider pruning stale sessions" },
    );
  }

  if (pct >= SESSION_PRESSURE_WARN_PCT) {
    return indicator(
      "sessionPressure",
      "Session Pressure",
      "warning",
      `Session index at ${pct.toFixed(0)}% capacity`,
      snapshot.capturedAt,
      { valueText },
    );
  }

  return indicator(
    "sessionPressure",
    "Session Pressure",
    "healthy",
    `${count} sessions (${pct.toFixed(0)}% of limit)`,
    snapshot.capturedAt,
    { valueText },
  );
}

export function deriveStoragePressure(snapshot: SessionHealthRawSnapshot): SessionHealthIndicator {
  const { storage, maintenance } = snapshot;
  const total = storage.totalManagedBytes;
  const resetPct = total > 0 ? (storage.resetTranscriptBytes / total) * 100 : 0;

  // Determine base level from budget or absolute thresholds
  let level: SessionHealthLevel = "healthy";
  let pctText = "";

  if (maintenance.usagePercent.diskBytes != null) {
    const pct = maintenance.usagePercent.diskBytes;
    pctText = `${pct.toFixed(0)}% of budget`;
    if (pct >= STORAGE_PRESSURE_CRITICAL_PCT) {
      level = "critical";
    } else if (pct >= STORAGE_PRESSURE_WARN_PCT) {
      level = "warning";
    }
  } else {
    // No disk budget configured — use absolute thresholds
    if (total >= STORAGE_ABSOLUTE_CRITICAL_BYTES) {
      level = "critical";
    } else if (total >= STORAGE_ABSOLUTE_WARN_BYTES) {
      level = "warning";
    }
  }

  // Bump severity if reset transcripts dominate storage
  if (level === "healthy" && resetPct > RESET_BLOAT_WARN_PCT) {
    level = "warning";
  }

  const valueText = formatBytes(total);
  const resetNote =
    resetPct > RESET_BLOAT_WARN_PCT ? ` (${resetPct.toFixed(0)}% from reset transcripts)` : "";

  const summaryText =
    level === "healthy"
      ? `${formatBytes(total)} managed${pctText ? ` — ${pctText}` : ""}`
      : `Storage at ${pctText || formatBytes(total)}${resetNote}`;

  return indicator("storagePressure", "Storage Pressure", level, summaryText, snapshot.capturedAt, {
    valueText,
    actionHint: level !== "healthy" ? "Review session cleanup options" : undefined,
  });
}

export function deriveGrowthTrend(snapshot: SessionHealthRawSnapshot): SessionHealthIndicator {
  const { growth, sessions } = snapshot;

  // No growth data yet — need at least 24h of history
  if (growth.indexedCount24h == null && growth.sessionsBytes24h == null) {
    return indicator(
      "growthTrend",
      "Growth Trend",
      "unknown",
      "Insufficient history — collecting baseline",
      snapshot.capturedAt,
    );
  }

  const currentCount = sessions.indexedCount;
  const count24h = growth.indexedCount24h ?? 0;
  const count7d = growth.indexedCount7d;

  // Compute growth as % of current index
  const growthPct24h = currentCount > 0 ? (count24h / currentCount) * 100 : 0;
  const growthPct7d = count7d != null && currentCount > 0 ? (count7d / currentCount) * 100 : null;

  let level: SessionHealthLevel = "healthy";
  if (growthPct24h >= GROWTH_24H_CRITICAL_PCT) {
    level = "critical";
  } else if (
    growthPct24h >= GROWTH_24H_WARN_PCT ||
    (growthPct7d != null && growthPct7d >= GROWTH_7D_WARN_PCT)
  ) {
    level = "warning";
  }

  const parts: string[] = [];
  if (count24h !== 0) {
    const sign = count24h > 0 ? "+" : "";
    parts.push(`${sign}${count24h} sessions (24h)`);
  }
  if (count7d != null && count7d !== 0) {
    const sign = count7d > 0 ? "+" : "";
    parts.push(`${sign}${count7d} (7d)`);
  }
  if (growth.sessionsBytes24h != null && growth.sessionsBytes24h !== 0) {
    const sign = growth.sessionsBytes24h > 0 ? "+" : "";
    parts.push(`${sign}${formatBytes(Math.abs(growth.sessionsBytes24h))} disk (24h)`);
  }

  const summary = parts.length > 0 ? parts.join(", ") : "Stable — no significant growth";

  return indicator("growthTrend", "Growth Trend", level, summary, snapshot.capturedAt, {
    valueText: count24h !== 0 ? `${count24h > 0 ? "+" : ""}${count24h}/24h` : "0/24h",
    actionHint: level !== "healthy" ? "Review cron/background run retention" : undefined,
  });
}

export function deriveStalestOrphan(snapshot: SessionHealthRawSnapshot): SessionHealthIndicator {
  const { drift } = snapshot;

  if (drift.orphanedTempCount === 0 || !drift.oldestOrphanedTempAt) {
    return indicator(
      "stalestOrphan",
      "Stale Artifacts",
      "healthy",
      "No orphaned temp files",
      snapshot.capturedAt,
    );
  }

  const orphanAge = Date.now() - new Date(drift.oldestOrphanedTempAt).getTime();

  let level: SessionHealthLevel = "warning";
  if (orphanAge >= ORPHAN_CRITICAL_AGE_MS) {
    level = "critical";
  }

  return indicator(
    "stalestOrphan",
    "Stale Artifacts",
    level,
    `${drift.orphanedTempCount} orphaned temp file${drift.orphanedTempCount > 1 ? "s" : ""} — oldest ${formatDuration(orphanAge)} ago`,
    snapshot.capturedAt,
    {
      valueText: formatDuration(orphanAge),
      actionHint: "Safe to remove orphaned .tmp files",
    },
  );
}

// ---------------------------------------------------------------------------
// Overall surface derivation
// ---------------------------------------------------------------------------

/**
 * Derive the overall level from all indicators.
 * Uses worst-case: critical > warning > unknown > healthy.
 * `stale_data` overrides everything when the snapshot is too old.
 *
 * TODO: When the collector stalls, the surface permanently shows `stale_data`
 * and hides the last-known indicator levels. A future improvement could
 * preserve the last-good indicator data alongside the stale_data override
 * so operators can still see what the indicators looked like before the
 * collector stopped. This is a UX honesty gap, not a correctness bug — the
 * current behavior is safe (it signals "don't trust this data") but not
 * maximally informative.
 */
function deriveOverallLevel(
  indicators: SessionHealthIndicator[],
  capturedAt: string,
): SessionHealthLevel {
  const snapshotAge = Date.now() - new Date(capturedAt).getTime();
  if (snapshotAge > STALE_SNAPSHOT_MS) {
    return "stale_data";
  }

  const levels = new Set(indicators.map((i) => i.level));
  if (levels.has("critical")) {
    return "critical";
  }
  if (levels.has("warning")) {
    return "warning";
  }
  if (levels.has("unknown")) {
    return "unknown";
  }
  return "healthy";
}

function buildOverallSummary(
  level: SessionHealthLevel,
  indicators: SessionHealthIndicator[],
): string {
  switch (level) {
    case "healthy":
      return "All session health indicators are healthy";
    case "stale_data":
      return "Session health data is stale — collector may have stopped";
    case "unknown":
      return "Some indicators are still collecting baseline data";
    case "warning": {
      const warns = indicators.filter((i) => i.level === "warning");
      return `${warns.length} indicator${warns.length > 1 ? "s" : ""} need${warns.length === 1 ? "s" : ""} attention`;
    }
    case "critical": {
      const crits = indicators.filter((i) => i.level === "critical");
      return `${crits.length} critical indicator${crits.length > 1 ? "s" : ""}`;
    }
  }
}

/**
 * Derive the full operator-facing Session Health surface from a raw snapshot.
 *
 * This is the primary entry point. The result is cached and served through
 * the health RPC as `sessionHealthSurface`.
 */
export function deriveSessionHealthSurface(
  snapshot: SessionHealthRawSnapshot,
): SessionHealthSurface {
  const indicators: SessionHealthIndicator[] = [
    deriveIndexHealth(snapshot),
    deriveSessionPressure(snapshot),
    deriveStoragePressure(snapshot),
    deriveGrowthTrend(snapshot),
    deriveStalestOrphan(snapshot),
  ];

  const overallLevel = deriveOverallLevel(indicators, snapshot.capturedAt);

  return {
    overallLevel,
    summary: buildOverallSummary(overallLevel, indicators),
    indicators,
    diagnosticsAvailable: true,
    measuredAt: snapshot.capturedAt,
    lastHealthyAt: overallLevel === "healthy" ? snapshot.capturedAt : null,
  };
}
