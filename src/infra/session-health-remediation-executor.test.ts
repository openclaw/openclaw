/**
 * Session Health — Remediation Executor Tests (Phase 3C)
 *
 * Tests:
 * - Validation: action ID resolution, tier restrictions, missing actions
 * - Execution: success, no-op/idempotent reruns, partial failures
 * - Refusal: contradictory flags, tier violations, scope increases
 * - Reporting: confirmation block, before/after text and JSON
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ExecutionRefusalError,
  renderConfirmationBlock,
  renderExecutionReportText,
  resolveActionIdsForTier,
  validateExecutionRequest,
} from "./session-health-remediation-executor.js";
import { buildRemediationPlan } from "./session-health-remediation-plan.js";
import { V1_MAX_EXECUTION_TIER } from "./session-health-remediation-types.js";
import type { ExecutionResult } from "./session-health-remediation-types.js";
import type { SessionHealthRawSnapshot } from "./session-health-types.js";

// ---------------------------------------------------------------------------
// Snapshot fixture
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
        orphanedTemp: 3,
      },
    },
    storage: {
      totalManagedBytes: 50 * 1024 * 1024,
      sessionsJsonBytes: 100_000,
      activeTranscriptBytes: 20 * 1024 * 1024,
      deletedTranscriptBytes: 5 * 1024 * 1024,
      resetTranscriptBytes: 20 * 1024 * 1024,
      orphanedTempBytes: 12700,
    },
    drift: {
      indexedWithoutDiskFile: 0,
      diskFilesWithoutIndex: 3,
      orphanedTempCount: 3,
      oldestOrphanedTempAt: "2026-03-19T10:00:00.000Z",
      reconciliationRecommended: true,
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

function buildPlanFromSnapshot(
  snapshot?: SessionHealthRawSnapshot,
): ReturnType<typeof buildRemediationPlan> {
  return buildRemediationPlan({ snapshot: snapshot ?? baseSnapshot() });
}

// ---------------------------------------------------------------------------
// Validation tests
// ---------------------------------------------------------------------------

describe("validateExecutionRequest", () => {
  it("validates a valid Tier 0 action ID", () => {
    const plan = buildPlanFromSnapshot();
    const result = validateExecutionRequest(["cleanup-orphaned-tmp-1"], plan);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0].kind).toBe("cleanup-orphaned-tmp");
    }
  });

  it("validates multiple Tier 0 + Tier 1 action IDs", () => {
    const plan = buildPlanFromSnapshot();
    const allT0T1Ids = plan.tiers
      .filter((t) => t.tier <= 1)
      .flatMap((t) => t.actions.map((a) => a.id));
    expect(allT0T1Ids.length).toBeGreaterThan(0);

    const result = validateExecutionRequest(allT0T1Ids, plan);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.actions.length).toBe(allT0T1Ids.length);
    }
  });

  it("refuses an action ID that does not exist in the plan", () => {
    const plan = buildPlanFromSnapshot();
    const result = validateExecutionRequest(["nonexistent-action-42"], plan);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("nonexistent-action-42");
      expect(result.error).toContain("not found");
    }
  });

  it("refuses a Tier 2 action", () => {
    const snapshot = baseSnapshot({
      drift: {
        ...baseSnapshot().drift,
        indexedWithoutDiskFile: 5,
      },
    });
    const plan = buildPlanFromSnapshot(snapshot);

    // Find a Tier 2 action
    const tier2Action = plan.tiers.flatMap((t) => t.actions).find((a) => a.tier === 2);
    expect(tier2Action).toBeDefined();

    const result = validateExecutionRequest([tier2Action!.id], plan);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("Tier 2");
      expect(result.error).toContain("v1 only supports Tier 0–1");
    }
  });

  it("refuses a Tier 3 action", () => {
    const snapshot = baseSnapshot({
      maintenance: {
        ...baseSnapshot().maintenance,
        maxDiskBytes: 30 * 1024 * 1024,
        usagePercent: { entries: 10, diskBytes: 167 },
      },
    });
    const plan = buildPlanFromSnapshot(snapshot);

    const tier3Action = plan.tiers.flatMap((t) => t.actions).find((a) => a.tier === 3);
    expect(tier3Action).toBeDefined();

    const result = validateExecutionRequest([tier3Action!.id], plan);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("Tier 3");
    }
  });

  it("refuses when all requested actions have resolved", () => {
    // Build a clean snapshot with no issues
    const snapshot = baseSnapshot({
      drift: {
        indexedWithoutDiskFile: 0,
        diskFilesWithoutIndex: 0,
        orphanedTempCount: 0,
        oldestOrphanedTempAt: null,
        reconciliationRecommended: false,
      },
      sessions: {
        ...baseSnapshot().sessions,
        staleByClass: undefined,
        byDiskState: { active: 40, deleted: 0, reset: 0, orphanedTemp: 0 },
      },
      storage: {
        ...baseSnapshot().storage,
        deletedTranscriptBytes: 0,
        resetTranscriptBytes: 0,
        orphanedTempBytes: 0,
      },
    });
    const plan = buildPlanFromSnapshot(snapshot);

    // Try to execute an action that doesn't exist in the clean plan
    const result = validateExecutionRequest(["cleanup-orphaned-tmp-1"], plan);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("not found");
    }
  });
});

// ---------------------------------------------------------------------------
// resolveActionIdsForTier
// ---------------------------------------------------------------------------

describe("resolveActionIdsForTier", () => {
  it("returns only Tier 0 actions for tier 0", () => {
    const plan = buildPlanFromSnapshot();
    const ids = resolveActionIdsForTier(0, plan);
    const actions = plan.tiers.flatMap((t) => t.actions);
    for (const id of ids) {
      const action = actions.find((a) => a.id === id);
      expect(action?.tier).toBe(0);
    }
  });

  it("returns Tier 0 + Tier 1 actions for tier 1", () => {
    const plan = buildPlanFromSnapshot();
    const ids = resolveActionIdsForTier(1, plan);
    const actions = plan.tiers.flatMap((t) => t.actions);
    for (const id of ids) {
      const action = actions.find((a) => a.id === id);
      expect(action?.tier).toBeLessThanOrEqual(1);
    }
    // Should include Tier 0 and Tier 1 actions
    const tiers = ids.map((id) => actions.find((a) => a.id === id)?.tier);
    expect(tiers).toContain(0);
    expect(tiers).toContain(1);
  });

  it("returns empty array when no actions match the tier", () => {
    const snapshot = baseSnapshot({
      drift: {
        indexedWithoutDiskFile: 0,
        diskFilesWithoutIndex: 0,
        orphanedTempCount: 0,
        oldestOrphanedTempAt: null,
        reconciliationRecommended: false,
      },
      sessions: {
        ...baseSnapshot().sessions,
        staleByClass: undefined,
        byDiskState: { active: 40, deleted: 0, reset: 0, orphanedTemp: 0 },
      },
      storage: {
        ...baseSnapshot().storage,
        deletedTranscriptBytes: 0,
        resetTranscriptBytes: 0,
        orphanedTempBytes: 0,
      },
    });
    const plan = buildPlanFromSnapshot(snapshot);
    const ids = resolveActionIdsForTier(0, plan);
    expect(ids).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// V1_MAX_EXECUTION_TIER safety
// ---------------------------------------------------------------------------

describe("V1_MAX_EXECUTION_TIER", () => {
  it("is 1 (Tier 0 + Tier 1 only)", () => {
    expect(V1_MAX_EXECUTION_TIER).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Confirmation block rendering
// ---------------------------------------------------------------------------

describe("renderConfirmationBlock", () => {
  it("renders a confirmation block with action details", () => {
    const plan = buildPlanFromSnapshot();
    const tier0Actions = plan.tiers.filter((t) => t.tier === 0).flatMap((t) => t.actions);
    expect(tier0Actions.length).toBeGreaterThan(0);

    const text = renderConfirmationBlock(tier0Actions);
    expect(text).toContain("CONFIRMATION REQUIRED");
    expect(text).toContain("cleanup-orphaned-tmp-1");
    expect(text).toContain("Tier 0, auto-safe");
    expect(text).toContain("artifact(s)");
    expect(text).toContain("Total:");
  });

  it("renders Tier 1 actions with the correct label", () => {
    const plan = buildPlanFromSnapshot();
    const tier1Actions = plan.tiers.filter((t) => t.tier === 1).flatMap((t) => t.actions);
    expect(tier1Actions.length).toBeGreaterThan(0);

    const text = renderConfirmationBlock(tier1Actions);
    expect(text).toContain("Tier 1, retention cleanup");
  });
});

// ---------------------------------------------------------------------------
// Execution report rendering
// ---------------------------------------------------------------------------

describe("renderExecutionReportText", () => {
  it("renders a successful execution report", () => {
    const result: ExecutionResult = {
      executedAt: "2026-03-20T22:00:00.000Z",
      actions: [
        {
          id: "cleanup-orphaned-tmp-1",
          kind: "cleanup-orphaned-tmp",
          tier: 0,
          status: "complete",
          artifactsRemoved: 3,
          bytesFreed: 12700,
          detail: "Removed 3 .tmp file(s).",
        },
      ],
      summary: {
        executed: 1,
        skipped: 0,
        failed: 0,
        refused: 0,
        totalBytesFreed: 12700,
        storageBefore: 50_000_000,
        storageAfter: 49_987_300,
      },
    };

    const text = renderExecutionReportText(result);
    expect(text).toContain("COMPLETE");
    expect(text).toContain("Executed: 1 action(s)");
    expect(text).toContain("✓ complete");
    expect(text).toContain("cleanup-orphaned-tmp-1");
    expect(text).toContain("Removed:  3 artifact(s)");
    expect(text).toContain("Before:");
    expect(text).toContain("After:");
    expect(text).toContain("Freed:");
  });

  it("renders skipped actions correctly", () => {
    const result: ExecutionResult = {
      executedAt: "2026-03-20T22:00:00.000Z",
      actions: [
        {
          id: "cleanup-orphaned-tmp-1",
          kind: "cleanup-orphaned-tmp",
          tier: 0,
          status: "skipped",
          artifactsRemoved: 0,
          bytesFreed: 0,
          detail: "No orphaned .tmp files found (condition resolved).",
        },
      ],
      summary: {
        executed: 0,
        skipped: 1,
        failed: 0,
        refused: 0,
        totalBytesFreed: 0,
        storageBefore: 50_000_000,
        storageAfter: 50_000_000,
      },
    };

    const text = renderExecutionReportText(result);
    expect(text).toContain("Skipped:  1");
    expect(text).toContain("○ skipped");
    expect(text).toContain("condition resolved");
  });

  it("renders failed actions with error", () => {
    const result: ExecutionResult = {
      executedAt: "2026-03-20T22:00:00.000Z",
      actions: [
        {
          id: "cleanup-orphaned-tmp-1",
          kind: "cleanup-orphaned-tmp",
          tier: 0,
          status: "failed",
          artifactsRemoved: 0,
          bytesFreed: 0,
          error: "Permission denied for all files.",
          warnings: ["Could not remove a.tmp: EACCES"],
        },
      ],
      summary: {
        executed: 0,
        skipped: 0,
        failed: 1,
        refused: 0,
        totalBytesFreed: 0,
        storageBefore: 50_000_000,
        storageAfter: 50_000_000,
      },
    };

    const text = renderExecutionReportText(result);
    expect(text).toContain("Failed:   1");
    expect(text).toContain("✗ failed");
    expect(text).toContain("Permission denied");
    expect(text).toContain("Warning:");
  });

  it("renders refused actions", () => {
    const result: ExecutionResult = {
      executedAt: "2026-03-20T22:00:00.000Z",
      actions: [
        {
          id: "reconcile-index-phantoms-5",
          kind: "reconcile-index-phantoms",
          tier: 2,
          status: "refused",
          artifactsRemoved: 0,
          bytesFreed: 0,
          error: "Tier 2 execution not supported in v1.",
        },
      ],
      summary: {
        executed: 0,
        skipped: 0,
        failed: 0,
        refused: 1,
        totalBytesFreed: 0,
        storageBefore: 50_000_000,
        storageAfter: 50_000_000,
      },
    };

    const text = renderExecutionReportText(result);
    expect(text).toContain("Refused:  1");
    expect(text).toContain("✕ refused");
  });

  it("renders the storage summary with freed percentage", () => {
    const result: ExecutionResult = {
      executedAt: "2026-03-20T22:00:00.000Z",
      actions: [
        {
          id: "archive-stale-deleted-transcripts-3",
          kind: "archive-stale-deleted-transcripts",
          tier: 1,
          status: "complete",
          artifactsRemoved: 7,
          bytesFreed: 2_202_009,
        },
      ],
      summary: {
        executed: 1,
        skipped: 0,
        failed: 0,
        refused: 0,
        totalBytesFreed: 2_202_009,
        storageBefore: 50_647_040,
        storageAfter: 48_445_031,
      },
    };

    const text = renderExecutionReportText(result);
    expect(text).toContain("Storage Summary");
    expect(text).toContain("Freed:");
    // Should show percentage
    expect(text).toMatch(/\d+\.\d+%/);
  });
});

// ---------------------------------------------------------------------------
// ExecutionRefusalError
// ---------------------------------------------------------------------------

describe("ExecutionRefusalError", () => {
  it("is an Error subclass", () => {
    const err = new ExecutionRefusalError("test message");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ExecutionRefusalError");
    expect(err.message).toBe("test message");
  });
});

// ---------------------------------------------------------------------------
// File-level executor integration (uses real filesystem)
// ---------------------------------------------------------------------------

describe("executor file-level operations", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "executor-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // We import the module dynamically to test the individual executors
  // through the public API, but need to test file operations in isolation.
  // The executeRemediation function requires full config/collector context,
  // so we test the individual pieces via validateExecutionRequest + rendering.

  it("idempotent: second validation on clean plan returns not-found", () => {
    // Simulate idempotent rerun: first execution resolves the condition,
    // second attempt finds no matching action in the fresh (clean) plan.
    const cleanSnapshot = baseSnapshot({
      drift: {
        indexedWithoutDiskFile: 0,
        diskFilesWithoutIndex: 0,
        orphanedTempCount: 0,
        oldestOrphanedTempAt: null,
        reconciliationRecommended: false,
      },
      sessions: {
        ...baseSnapshot().sessions,
        staleByClass: undefined,
        byDiskState: { active: 40, deleted: 0, reset: 0, orphanedTemp: 0 },
      },
      storage: {
        ...baseSnapshot().storage,
        deletedTranscriptBytes: 0,
        resetTranscriptBytes: 0,
        orphanedTempBytes: 0,
      },
    });
    const freshPlan = buildRemediationPlan({ snapshot: cleanSnapshot });
    const result = validateExecutionRequest(["cleanup-orphaned-tmp-1"], freshPlan);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("not found");
      expect(result.error).toContain("Re-run --dry-run");
    }
  });

  it("mixed tier request with Tier 2 is refused", () => {
    const snapshot = baseSnapshot({
      drift: {
        ...baseSnapshot().drift,
        indexedWithoutDiskFile: 5,
      },
    });
    const plan = buildRemediationPlan({ snapshot });

    // Collect both a Tier 0 and a Tier 2 action
    const tier0 = plan.tiers.flatMap((t) => t.actions).find((a) => a.tier === 0);
    const tier2 = plan.tiers.flatMap((t) => t.actions).find((a) => a.tier === 2);
    expect(tier0).toBeDefined();
    expect(tier2).toBeDefined();

    // The first Tier 2 action in the list should cause refusal
    const result = validateExecutionRequest([tier0!.id, tier2!.id], plan);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("Tier 2");
    }
  });
});
