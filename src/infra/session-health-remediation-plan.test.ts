/**
 * Session Health — Remediation Plan Builder Tests
 *
 * Tests the pure plan generation logic. Verifies that:
 * - Plans are correctly generated from snapshots
 * - Actions are tiered correctly
 * - Zero-impact actions are omitted by default
 * - The approval model is correctly computed
 * - The text renderer produces readable output
 */

import { describe, expect, it } from "vitest";
import {
  buildRemediationPlan,
  renderRemediationPlanText,
} from "./session-health-remediation-plan.js";
import { ACTION_KIND_TIERS } from "./session-health-remediation-types.js";
import type { SessionHealthRawSnapshot } from "./session-health-types.js";

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

function baseSnapshot(overrides?: Partial<SessionHealthRawSnapshot>): SessionHealthRawSnapshot {
  return {
    capturedAt: "2026-03-20T18:00:00.000Z",
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
      // staleByClass reflects age-filtered counts (sessions past retention threshold)
      staleByClass: {
        "cron-run": 12,
        subagent: 4,
        acp: 2,
        heartbeat: 1,
      },
      byDiskState: {
        active: 40,
        deleted: 5,
        reset: 10,
        orphanedTemp: 0,
      },
    },
    storage: {
      totalManagedBytes: 50 * 1024 * 1024,
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
// Basic plan generation
// ---------------------------------------------------------------------------

describe("buildRemediationPlan", () => {
  it("returns an empty plan when snapshot is clean", () => {
    const snapshot = baseSnapshot({
      sessions: {
        ...baseSnapshot().sessions,
        byClass: {
          main: 2,
          channel: 5,
          direct: 3,
          "cron-definition": 2,
          "cron-run": 0,
          subagent: 0,
          acp: 0,
          heartbeat: 0,
          thread: 2,
          unknown: 0,
        },
        staleByClass: undefined,
        byDiskState: {
          active: 14,
          deleted: 0,
          reset: 0,
          orphanedTemp: 0,
        },
      },
      storage: {
        ...baseSnapshot().storage,
        deletedTranscriptBytes: 0,
        resetTranscriptBytes: 0,
        orphanedTempBytes: 0,
      },
    });
    const plan = buildRemediationPlan({ snapshot });
    expect(plan.summary.totalActions).toBe(0);
    expect(plan.tiers).toHaveLength(0);
    expect(plan.summary.recommendation).toContain("No remediation actions");
  });

  it("includes generated/snapshot timestamps", () => {
    const snapshot = baseSnapshot();
    const plan = buildRemediationPlan({ snapshot });
    expect(plan.generatedAt).toBeTruthy();
    expect(plan.snapshotAt).toBe(snapshot.capturedAt);
  });

  it("always produces a valid approval model", () => {
    const plan = buildRemediationPlan({ snapshot: baseSnapshot() });
    expect(plan.approvalModel).toBeDefined();
    expect(plan.approvalModel.autoApprovable).toBeInstanceOf(Array);
    expect(plan.approvalModel.previewThenAutomate).toBeInstanceOf(Array);
    expect(plan.approvalModel.explicitApprovalRequired).toBeInstanceOf(Array);
    expect(plan.approvalModel.neverAutomate).toBeInstanceOf(Array);
  });
});

// ---------------------------------------------------------------------------
// Tier 0 — Auto-Safe
// ---------------------------------------------------------------------------

describe("Tier 0: cleanup-orphaned-tmp", () => {
  it("proposes tmp cleanup when orphaned temp files exist", () => {
    const snapshot = baseSnapshot({
      drift: {
        ...baseSnapshot().drift,
        orphanedTempCount: 3,
        oldestOrphanedTempAt: "2026-03-19T10:00:00.000Z",
      },
      storage: {
        ...baseSnapshot().storage,
        orphanedTempBytes: 8192,
      },
    });
    const plan = buildRemediationPlan({ snapshot });
    const tmpAction = plan.tiers
      .find((t) => t.tier === 0)
      ?.actions.find((a) => a.kind === "cleanup-orphaned-tmp");
    expect(tmpAction).toBeDefined();
    expect(tmpAction?.tier).toBe(0);
    expect(tmpAction?.estimatedImpact.affectedCount).toBe(3);
    expect(tmpAction?.estimatedImpact.estimatedBytes).toBe(8192);
    expect(tmpAction?.reversible).toBe(false);
  });

  it("skips tmp cleanup when no orphaned temp files", () => {
    const plan = buildRemediationPlan({ snapshot: baseSnapshot() });
    const tmpActions = plan.tiers
      .flatMap((t) => t.actions)
      .filter((a) => a.kind === "cleanup-orphaned-tmp");
    expect(tmpActions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tier 1 — Reversible
// ---------------------------------------------------------------------------

describe("Tier 1: archive actions", () => {
  it("proposes orphan transcript archival when drift exists", () => {
    const snapshot = baseSnapshot({
      drift: {
        ...baseSnapshot().drift,
        diskFilesWithoutIndex: 5,
      },
    });
    const plan = buildRemediationPlan({ snapshot });
    const action = plan.tiers
      .flatMap((t) => t.actions)
      .find((a) => a.kind === "archive-orphan-transcripts");
    expect(action).toBeDefined();
    expect(action?.tier).toBe(1);
    expect(action?.reversible).toBe(true);
    expect(action?.estimatedImpact.affectedCount).toBe(5);
  });

  it("proposes stale deleted transcript cleanup when present", () => {
    const snapshot = baseSnapshot();
    const plan = buildRemediationPlan({ snapshot });
    const action = plan.tiers
      .flatMap((t) => t.actions)
      .find((a) => a.kind === "archive-stale-deleted-transcripts");
    expect(action).toBeDefined();
    expect(action?.tier).toBe(1);
    expect(action?.estimatedImpact.affectedCount).toBe(5); // 5 deleted files
  });

  it("proposes stale reset transcript cleanup when present", () => {
    const snapshot = baseSnapshot();
    const plan = buildRemediationPlan({ snapshot });
    const action = plan.tiers
      .flatMap((t) => t.actions)
      .find((a) => a.kind === "archive-stale-reset-transcripts");
    expect(action).toBeDefined();
    expect(action?.tier).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tier 2 — Index-Mutating
// ---------------------------------------------------------------------------

describe("Tier 2: index-mutating actions", () => {
  it("proposes phantom reconciliation when index drift exists", () => {
    const snapshot = baseSnapshot({
      drift: {
        ...baseSnapshot().drift,
        indexedWithoutDiskFile: 8,
      },
    });
    const plan = buildRemediationPlan({ snapshot });
    const action = plan.tiers
      .flatMap((t) => t.actions)
      .find((a) => a.kind === "reconcile-index-phantoms");
    expect(action).toBeDefined();
    expect(action?.tier).toBe(2);
    expect(action?.estimatedImpact.affectedCount).toBe(8);
    expect(action?.prerequisites).toContain("archive-orphan-transcripts");
  });

  it("proposes pruning stale cron-run sessions using stale count, not total", () => {
    const snapshot = baseSnapshot();
    const plan = buildRemediationPlan({ snapshot });
    const action = plan.tiers
      .flatMap((t) => t.actions)
      .find((a) => a.kind === "prune-stale-cron-runs");
    expect(action).toBeDefined();
    expect(action?.tier).toBe(2);
    expect(action?.estimatedImpact.affectedClasses).toContain("cron-run");
    // Uses staleByClass count (12), NOT total byClass count (20)
    expect(action?.estimatedImpact.affectedCount).toBe(12);
  });

  it("proposes pruning stale subagent sessions using stale count", () => {
    const snapshot = baseSnapshot();
    const plan = buildRemediationPlan({ snapshot });
    const action = plan.tiers
      .flatMap((t) => t.actions)
      .find((a) => a.kind === "prune-stale-subagents");
    expect(action).toBeDefined();
    // Uses staleByClass count (4), NOT total byClass count (10)
    expect(action?.estimatedImpact.affectedCount).toBe(4);
  });

  it("proposes pruning stale ACP sessions using stale count", () => {
    const snapshot = baseSnapshot();
    const plan = buildRemediationPlan({ snapshot });
    const action = plan.tiers.flatMap((t) => t.actions).find((a) => a.kind === "prune-stale-acp");
    expect(action).toBeDefined();
    // Uses staleByClass count (2), NOT total byClass count (5)
    expect(action?.estimatedImpact.affectedCount).toBe(2);
  });

  it("does not propose pruning when stale count is zero even if total is nonzero", () => {
    const snapshot = baseSnapshot({
      sessions: {
        ...baseSnapshot().sessions,
        byClass: {
          ...baseSnapshot().sessions.byClass,
          heartbeat: 5, // 5 total heartbeat sessions...
        },
        staleByClass: {
          ...baseSnapshot().sessions.staleByClass,
          heartbeat: 0, // ...but none are stale
        },
      },
    });
    const plan = buildRemediationPlan({ snapshot });
    const action = plan.tiers
      .flatMap((t) => t.actions)
      .find((a) => a.kind === "prune-stale-heartbeats");
    expect(action).toBeUndefined();
  });

  it("does not propose pruning when staleByClass is missing", () => {
    const snapshot = baseSnapshot({
      sessions: {
        ...baseSnapshot().sessions,
        staleByClass: undefined,
      },
    });
    const plan = buildRemediationPlan({ snapshot });
    const pruneActions = plan.tiers
      .flatMap((t) => t.actions)
      .filter((a) => a.kind.startsWith("prune-stale-"));
    expect(pruneActions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tier 3 — Destructive
// ---------------------------------------------------------------------------

describe("Tier 3: destructive actions", () => {
  it("proposes disk budget enforcement only when over budget", () => {
    const snapshot = baseSnapshot({
      maintenance: {
        ...baseSnapshot().maintenance,
        maxDiskBytes: 30 * 1024 * 1024, // 30 MB budget
        usagePercent: {
          entries: 10,
          diskBytes: 167, // way over
        },
      },
    });
    const plan = buildRemediationPlan({ snapshot });
    const action = plan.tiers
      .flatMap((t) => t.actions)
      .find((a) => a.kind === "enforce-disk-budget");
    expect(action).toBeDefined();
    expect(action?.tier).toBe(3);
    expect(action?.reversible).toBe(false);
  });

  it("does not propose disk budget when not configured", () => {
    const plan = buildRemediationPlan({ snapshot: baseSnapshot() });
    const action = plan.tiers
      .flatMap((t) => t.actions)
      .find((a) => a.kind === "enforce-disk-budget");
    expect(action).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Summary and recommendation
// ---------------------------------------------------------------------------

describe("plan summary", () => {
  it("counts actions by tier", () => {
    const snapshot = baseSnapshot({
      drift: {
        ...baseSnapshot().drift,
        orphanedTempCount: 2,
        oldestOrphanedTempAt: "2026-03-19T10:00:00.000Z",
      },
      storage: {
        ...baseSnapshot().storage,
        orphanedTempBytes: 1024,
      },
    });
    const plan = buildRemediationPlan({ snapshot });
    // Should have Tier 0 (orphaned tmp) + Tier 1 (deleted/reset archives) + Tier 2 (cron/subagent prune)
    expect(plan.summary.totalActions).toBeGreaterThan(0);
    expect(plan.summary.actionCountByTier[0]).toBeGreaterThanOrEqual(1);
  });

  it("includes recoverable bytes estimate", () => {
    const plan = buildRemediationPlan({ snapshot: baseSnapshot() });
    expect(typeof plan.summary.estimatedRecoverableBytes).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Approval model
// ---------------------------------------------------------------------------

describe("approval model", () => {
  it("only includes action kinds active in the current plan", () => {
    const plan = buildRemediationPlan({ snapshot: baseSnapshot() });
    const allKinds = new Set([
      ...plan.approvalModel.autoApprovable,
      ...plan.approvalModel.previewThenAutomate,
      ...plan.approvalModel.explicitApprovalRequired,
      ...plan.approvalModel.neverAutomate,
    ]);

    // Every kind in the approval model should correspond to an action in the plan
    const planActionKinds = new Set(plan.tiers.flatMap((t) => t.actions.map((a) => a.kind)));
    for (const kind of allKinds) {
      expect(planActionKinds.has(kind)).toBe(true);
    }

    // Inactive kinds (e.g., cleanup-orphaned-tmp when orphanedTempCount=0) should not appear
    expect(allKinds.has("cleanup-orphaned-tmp")).toBe(false); // No orphaned tmp in base snapshot
  });

  it("includes cleanup-orphaned-tmp when orphaned temps exist", () => {
    const snapshot = baseSnapshot({
      drift: {
        ...baseSnapshot().drift,
        orphanedTempCount: 1,
        oldestOrphanedTempAt: "2026-03-19T00:00:00.000Z",
      },
      storage: {
        ...baseSnapshot().storage,
        orphanedTempBytes: 512,
      },
    });
    const plan = buildRemediationPlan({ snapshot });
    expect(plan.approvalModel.autoApprovable).toContain("cleanup-orphaned-tmp");
  });

  it("archive actions are preview-then-automate when present", () => {
    const plan = buildRemediationPlan({ snapshot: baseSnapshot() });
    // baseSnapshot has deleted and reset transcripts, so these should be present
    expect(plan.approvalModel.previewThenAutomate).toContain("archive-stale-deleted-transcripts");
    expect(plan.approvalModel.previewThenAutomate).toContain("archive-stale-reset-transcripts");
  });

  it("prune actions require explicit approval when present", () => {
    const plan = buildRemediationPlan({ snapshot: baseSnapshot() });
    // baseSnapshot has staleByClass entries for cron-run
    expect(plan.approvalModel.explicitApprovalRequired).toContain("prune-stale-cron-runs");
  });

  it("destructive actions are never-automate when present", () => {
    const snapshot = baseSnapshot({
      maintenance: {
        ...baseSnapshot().maintenance,
        maxDiskBytes: 30 * 1024 * 1024, // 30 MB budget
        usagePercent: {
          entries: 10,
          diskBytes: 167, // way over
        },
      },
    });
    const plan = buildRemediationPlan({ snapshot });
    expect(plan.approvalModel.neverAutomate).toContain("enforce-disk-budget");
  });

  it("does not include inactive kinds like purge-archived-artifacts or bulk-class-prune when no action uses them", () => {
    const plan = buildRemediationPlan({ snapshot: baseSnapshot() });
    expect(plan.approvalModel.neverAutomate).not.toContain("purge-archived-artifacts");
    expect(plan.approvalModel.neverAutomate).not.toContain("bulk-class-prune");
  });
});

// ---------------------------------------------------------------------------
// Tier groups
// ---------------------------------------------------------------------------

describe("tier groups", () => {
  it("groups are sorted by tier ascending", () => {
    const snapshot = baseSnapshot({
      drift: {
        ...baseSnapshot().drift,
        orphanedTempCount: 1,
        oldestOrphanedTempAt: "2026-03-19T00:00:00.000Z",
        indexedWithoutDiskFile: 3,
      },
      storage: {
        ...baseSnapshot().storage,
        orphanedTempBytes: 512,
      },
    });
    const plan = buildRemediationPlan({ snapshot });
    const tierNumbers = plan.tiers.map((t) => t.tier);
    expect(tierNumbers).toEqual([...tierNumbers].toSorted((a, b) => a - b));
  });

  it("tier 0 and 1 do not require approval", () => {
    const plan = buildRemediationPlan({ snapshot: baseSnapshot() });
    for (const tier of plan.tiers) {
      if (tier.tier <= 1) {
        expect(tier.approvalRequired).toBe(false);
      }
    }
  });

  it("tier 2 and 3 require approval", () => {
    const snapshot = baseSnapshot({
      drift: {
        ...baseSnapshot().drift,
        indexedWithoutDiskFile: 10,
      },
    });
    const plan = buildRemediationPlan({ snapshot });
    for (const tier of plan.tiers) {
      if (tier.tier >= 2) {
        expect(tier.approvalRequired).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// includeNoOpActions option
// ---------------------------------------------------------------------------

describe("includeNoOpActions", () => {
  it("omits zero-impact actions by default", () => {
    const snapshot = baseSnapshot({
      sessions: {
        ...baseSnapshot().sessions,
        byClass: {
          ...baseSnapshot().sessions.byClass,
          heartbeat: 0,
        },
        staleByClass: {
          ...baseSnapshot().sessions.staleByClass,
          heartbeat: 0,
        },
      },
    });
    const plan = buildRemediationPlan({ snapshot });
    const heartbeatAction = plan.tiers
      .flatMap((t) => t.actions)
      .find((a) => a.kind === "prune-stale-heartbeats");
    expect(heartbeatAction).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Text renderer
// ---------------------------------------------------------------------------

describe("renderRemediationPlanText", () => {
  it("renders a clean plan", () => {
    const snapshot = baseSnapshot({
      sessions: {
        ...baseSnapshot().sessions,
        byClass: {
          main: 2,
          channel: 0,
          direct: 0,
          "cron-definition": 0,
          "cron-run": 0,
          subagent: 0,
          acp: 0,
          heartbeat: 0,
          thread: 0,
          unknown: 0,
        },
        staleByClass: undefined,
        byDiskState: {
          active: 2,
          deleted: 0,
          reset: 0,
          orphanedTemp: 0,
        },
      },
      storage: {
        ...baseSnapshot().storage,
        deletedTranscriptBytes: 0,
        resetTranscriptBytes: 0,
      },
    });
    const plan = buildRemediationPlan({ snapshot });
    const text = renderRemediationPlanText(plan);
    expect(text).toContain("DRY RUN");
    expect(text).toContain("No remediation actions needed");
  });

  it("renders a plan with actions", () => {
    const snapshot = baseSnapshot({
      drift: {
        ...baseSnapshot().drift,
        orphanedTempCount: 2,
        oldestOrphanedTempAt: "2026-03-19T00:00:00.000Z",
        diskFilesWithoutIndex: 3,
      },
      storage: {
        ...baseSnapshot().storage,
        orphanedTempBytes: 4096,
      },
    });
    const plan = buildRemediationPlan({ snapshot });
    const text = renderRemediationPlanText(plan);
    expect(text).toContain("DRY RUN");
    expect(text).toContain("Tier 0");
    expect(text).toContain("Auto-Safe");
    expect(text).toContain("orphaned temp");
    expect(text).toContain("Approval Model");
    expect(text).toContain("No changes have been made");
  });

  it("includes tier descriptions and labels", () => {
    const plan = buildRemediationPlan({ snapshot: baseSnapshot() });
    const text = renderRemediationPlanText(plan);
    expect(text).toContain("REMEDIATION PLAN");
    expect(text).toContain("Generated:");
    expect(text).toContain("Snapshot:");
  });
});

// ---------------------------------------------------------------------------
// Action kind tier mapping is complete
// ---------------------------------------------------------------------------

describe("ACTION_KIND_TIERS completeness", () => {
  it("every action kind has a defined tier", () => {
    const allKinds: string[] = [
      "cleanup-orphaned-tmp",
      "archive-orphan-transcripts",
      "archive-stale-deleted-transcripts",
      "archive-stale-reset-transcripts",
      "reconcile-index-phantoms",
      "prune-stale-cron-runs",
      "prune-stale-subagents",
      "prune-stale-heartbeats",
      "prune-stale-acp",
      "enforce-disk-budget",
      "purge-archived-artifacts",
      "bulk-class-prune",
    ];
    for (const kind of allKinds) {
      expect(ACTION_KIND_TIERS).toHaveProperty(kind);
      const tier = ACTION_KIND_TIERS[kind as keyof typeof ACTION_KIND_TIERS];
      expect(tier).toBeGreaterThanOrEqual(0);
      expect(tier).toBeLessThanOrEqual(3);
    }
  });

  it("all defined tiers are valid", () => {
    for (const [_kind, tier] of Object.entries(ACTION_KIND_TIERS)) {
      expect([0, 1, 2, 3]).toContain(tier);
    }
  });
});
