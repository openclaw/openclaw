/**
 * Session Health — Layer B Derivation Tests
 *
 * Tests the threshold-based derivation logic that transforms raw snapshots
 * (Layer A) into operator-facing health surfaces (Layer B).
 */

import { describe, expect, it } from "vitest";
import {
  deriveGrowthTrend,
  deriveIndexHealth,
  deriveSessionHealthSurface,
  deriveSessionPressure,
  deriveStalestOrphan,
  deriveStoragePressure,
} from "./session-health-derive.js";
import type { SessionHealthRawSnapshot } from "./session-health-types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function baseSnapshot(overrides?: Partial<SessionHealthRawSnapshot>): SessionHealthRawSnapshot {
  return {
    capturedAt: new Date().toISOString(),
    collectorDurationMs: 42,
    sessions: {
      indexedCount: 50,
      sessionsJsonBytes: 100_000,
      sessionsJsonParseTimeMs: 5,
      byClass: {
        main: 2,
        channel: 5,
        direct: 3,
        "cron-definition": 2,
        "cron-run": 20,
        subagent: 10,
        acp: 5,
        heartbeat: 1,
        thread: 2,
        unknown: 0,
      },
      byDiskState: {
        active: 40,
        deleted: 5,
        reset: 10,
        orphanedTemp: 0,
      },
    },
    storage: {
      totalManagedBytes: 50 * 1024 * 1024, // 50 MB
      sessionsJsonBytes: 100_000,
      activeTranscriptBytes: 20 * 1024 * 1024,
      deletedTranscriptBytes: 5 * 1024 * 1024,
      resetTranscriptBytes: 20 * 1024 * 1024,
      orphanedTempBytes: 0,
    },
    drift: {
      indexedWithoutDiskFile: 0,
      diskFilesWithoutIndex: 0,
      orphanedTempCount: 0,
      oldestOrphanedTempAt: null,
      reconciliationRecommended: false,
    },
    maintenance: {
      mode: "warn",
      maxEntries: 500,
      pruneAfterMs: 7 * 24 * 60 * 60 * 1000,
      maxDiskBytes: null,
      usagePercent: {
        entries: 10,
        diskBytes: null,
      },
    },
    growth: {
      sessionsBytes24h: null,
      sessionsBytes7d: null,
      indexedCount24h: null,
      indexedCount7d: null,
    },
    agents: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Index Health
// ---------------------------------------------------------------------------

describe("deriveIndexHealth", () => {
  it("returns healthy when no drift", () => {
    const snap = baseSnapshot();
    const result = deriveIndexHealth(snap);
    expect(result.key).toBe("indexHealth");
    expect(result.level).toBe("healthy");
  });

  it("returns warning when drift is moderate", () => {
    const snap = baseSnapshot({
      drift: {
        ...baseSnapshot().drift,
        indexedWithoutDiskFile: 4,
        diskFilesWithoutIndex: 0,
      },
    });
    const result = deriveIndexHealth(snap);
    expect(result.level).toBe("warning");
  });

  it("returns critical when drift exceeds threshold", () => {
    const snap = baseSnapshot({
      drift: {
        ...baseSnapshot().drift,
        indexedWithoutDiskFile: 8,
        diskFilesWithoutIndex: 5,
      },
    });
    const result = deriveIndexHealth(snap);
    expect(result.level).toBe("critical");
  });

  it("returns critical when reconciliation is recommended", () => {
    const snap = baseSnapshot({
      drift: {
        ...baseSnapshot().drift,
        indexedWithoutDiskFile: 2,
        reconciliationRecommended: true,
      },
    });
    const result = deriveIndexHealth(snap);
    expect(result.level).toBe("critical");
  });

  it("returns warning when orphaned temp files exist", () => {
    const snap = baseSnapshot({
      drift: {
        ...baseSnapshot().drift,
        orphanedTempCount: 1,
      },
    });
    const result = deriveIndexHealth(snap);
    expect(result.level).toBe("warning");
  });
});

// ---------------------------------------------------------------------------
// Session Pressure
// ---------------------------------------------------------------------------

describe("deriveSessionPressure", () => {
  it("returns healthy when usage is low", () => {
    const snap = baseSnapshot();
    const result = deriveSessionPressure(snap);
    expect(result.key).toBe("sessionPressure");
    expect(result.level).toBe("healthy");
  });

  it("returns warning at 60% capacity", () => {
    const snap = baseSnapshot({
      maintenance: {
        ...baseSnapshot().maintenance,
        usagePercent: { entries: 62, diskBytes: null },
      },
    });
    const result = deriveSessionPressure(snap);
    expect(result.level).toBe("warning");
  });

  it("returns critical at 85%+ capacity", () => {
    const snap = baseSnapshot({
      maintenance: {
        ...baseSnapshot().maintenance,
        usagePercent: { entries: 90, diskBytes: null },
      },
    });
    const result = deriveSessionPressure(snap);
    expect(result.level).toBe("critical");
  });
});

// ---------------------------------------------------------------------------
// Storage Pressure
// ---------------------------------------------------------------------------

describe("deriveStoragePressure", () => {
  it("returns healthy when below absolute thresholds", () => {
    const snap = baseSnapshot();
    const result = deriveStoragePressure(snap);
    expect(result.key).toBe("storagePressure");
    expect(result.level).toBe("healthy");
  });

  it("returns warning when reset transcripts dominate", () => {
    const snap = baseSnapshot({
      storage: {
        ...baseSnapshot().storage,
        totalManagedBytes: 100 * 1024 * 1024,
        resetTranscriptBytes: 60 * 1024 * 1024, // 60% reset
      },
    });
    const result = deriveStoragePressure(snap);
    expect(result.level).toBe("warning");
  });

  it("returns warning when disk budget exceeds threshold", () => {
    const snap = baseSnapshot({
      maintenance: {
        ...baseSnapshot().maintenance,
        maxDiskBytes: 100 * 1024 * 1024,
        usagePercent: { entries: 10, diskBytes: 65 },
      },
    });
    const result = deriveStoragePressure(snap);
    expect(result.level).toBe("warning");
  });

  it("returns critical when disk budget exceeds 85%", () => {
    const snap = baseSnapshot({
      maintenance: {
        ...baseSnapshot().maintenance,
        maxDiskBytes: 100 * 1024 * 1024,
        usagePercent: { entries: 10, diskBytes: 90 },
      },
    });
    const result = deriveStoragePressure(snap);
    expect(result.level).toBe("critical");
  });

  it("returns warning above absolute threshold with no budget", () => {
    const snap = baseSnapshot({
      storage: {
        ...baseSnapshot().storage,
        totalManagedBytes: 600 * 1024 * 1024, // 600 MB
      },
    });
    const result = deriveStoragePressure(snap);
    expect(result.level).toBe("warning");
  });
});

// ---------------------------------------------------------------------------
// Growth Trend
// ---------------------------------------------------------------------------

describe("deriveGrowthTrend", () => {
  it("returns unknown when no growth data", () => {
    const snap = baseSnapshot();
    const result = deriveGrowthTrend(snap);
    expect(result.key).toBe("growthTrend");
    expect(result.level).toBe("unknown");
  });

  it("returns healthy for minor growth", () => {
    const snap = baseSnapshot({
      growth: {
        sessionsBytes24h: 1024,
        sessionsBytes7d: 5120,
        indexedCount24h: 1,
        indexedCount7d: 5,
      },
    });
    const result = deriveGrowthTrend(snap);
    expect(result.level).toBe("healthy");
  });

  it("returns warning for rapid 24h growth", () => {
    const snap = baseSnapshot({
      sessions: {
        ...baseSnapshot().sessions,
        indexedCount: 100,
      },
      growth: {
        sessionsBytes24h: 50 * 1024 * 1024,
        sessionsBytes7d: null,
        indexedCount24h: 8, // 8% of 100
        indexedCount7d: null,
      },
    });
    const result = deriveGrowthTrend(snap);
    expect(result.level).toBe("warning");
  });

  it("returns critical for explosive growth", () => {
    const snap = baseSnapshot({
      sessions: {
        ...baseSnapshot().sessions,
        indexedCount: 100,
      },
      growth: {
        sessionsBytes24h: 100 * 1024 * 1024,
        sessionsBytes7d: null,
        indexedCount24h: 20, // 20% of 100
        indexedCount7d: null,
      },
    });
    const result = deriveGrowthTrend(snap);
    expect(result.level).toBe("critical");
  });
});

// ---------------------------------------------------------------------------
// Stalest Orphan
// ---------------------------------------------------------------------------

describe("deriveStalestOrphan", () => {
  it("returns healthy when no orphans", () => {
    const snap = baseSnapshot();
    const result = deriveStalestOrphan(snap);
    expect(result.key).toBe("stalestOrphan");
    expect(result.level).toBe("healthy");
  });

  it("returns warning for recent orphans", () => {
    const snap = baseSnapshot({
      drift: {
        ...baseSnapshot().drift,
        orphanedTempCount: 2,
        oldestOrphanedTempAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h
      },
    });
    const result = deriveStalestOrphan(snap);
    expect(result.level).toBe("warning");
  });

  it("returns critical for old orphans", () => {
    const snap = baseSnapshot({
      drift: {
        ...baseSnapshot().drift,
        orphanedTempCount: 1,
        oldestOrphanedTempAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), // 48h
      },
    });
    const result = deriveStalestOrphan(snap);
    expect(result.level).toBe("critical");
  });
});

// ---------------------------------------------------------------------------
// Full surface derivation
// ---------------------------------------------------------------------------

describe("deriveSessionHealthSurface", () => {
  it("produces a complete surface with all 5 indicators", () => {
    const snap = baseSnapshot();
    const surface = deriveSessionHealthSurface(snap);
    expect(surface.indicators).toHaveLength(5);
    expect(surface.overallLevel).toBe("unknown"); // growth is unknown
    expect(surface.diagnosticsAvailable).toBe(true);
    expect(surface.measuredAt).toBe(snap.capturedAt);
  });

  it("overall level is healthy when all indicators healthy", () => {
    const snap = baseSnapshot({
      growth: {
        sessionsBytes24h: 0,
        sessionsBytes7d: 0,
        indexedCount24h: 0,
        indexedCount7d: 0,
      },
    });
    const surface = deriveSessionHealthSurface(snap);
    expect(surface.overallLevel).toBe("healthy");
  });

  it("overall level is critical when any indicator is critical", () => {
    const snap = baseSnapshot({
      drift: {
        ...baseSnapshot().drift,
        indexedWithoutDiskFile: 20,
        reconciliationRecommended: true,
      },
      growth: {
        sessionsBytes24h: 0,
        sessionsBytes7d: 0,
        indexedCount24h: 0,
        indexedCount7d: 0,
      },
    });
    const surface = deriveSessionHealthSurface(snap);
    expect(surface.overallLevel).toBe("critical");
  });

  it("overall level is stale_data when snapshot is old", () => {
    const snap = baseSnapshot({
      capturedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(), // 20 min ago
    });
    const surface = deriveSessionHealthSurface(snap);
    expect(surface.overallLevel).toBe("stale_data");
  });

  it("indicator keys match expected set", () => {
    const snap = baseSnapshot();
    const surface = deriveSessionHealthSurface(snap);
    const keys = surface.indicators.map((i) => i.key);
    expect(keys).toEqual([
      "indexHealth",
      "sessionPressure",
      "storagePressure",
      "growthTrend",
      "stalestOrphan",
    ]);
  });
});
