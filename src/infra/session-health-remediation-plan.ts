/**
 * Session Health — Remediation Plan Builder
 *
 * Generates a structured, human-reviewable remediation plan from a raw
 * health snapshot. This is a PURE function — it reads snapshot data and
 * produces a plan. It never touches disk, never deletes anything, never
 * mutates any state.
 *
 * Phase 3A safety contract:
 * - This module is report-only / dry-run-only / preview-only.
 * - It produces a plan describing what WOULD happen.
 * - Actual execution is deferred to a future phase with explicit approval gates.
 */

import type {
  ApprovalModel,
  BuildRemediationPlanOptions,
  RemediationAction,
  RemediationActionKind,
  RemediationPlan,
  RemediationPlanSummary,
  RemediationRiskTier,
  RemediationTierGroup,
} from "./session-health-remediation-types.js";
import {
  ACTION_KIND_TIERS,
  REMEDIATION_TIER_DESCRIPTIONS,
  REMEDIATION_TIER_LABELS,
} from "./session-health-remediation-types.js";
import type { SessionHealthClass, SessionHealthRawSnapshot } from "./session-health-types.js";

// ---------------------------------------------------------------------------
// Retention defaults (from Phase 1 taxonomy)
// ---------------------------------------------------------------------------

const DEFAULT_RETENTION_MS: Record<SessionHealthClass, number | null> = {
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
// Action builders (one per action kind)
// ---------------------------------------------------------------------------

let actionIdCounter = 0;

function nextActionId(kind: RemediationActionKind): string {
  actionIdCounter++;
  return `${kind}-${actionIdCounter}`;
}

function buildCleanupOrphanedTmp(snapshot: SessionHealthRawSnapshot): RemediationAction | null {
  const { drift, storage } = snapshot;
  if (drift.orphanedTempCount === 0) {
    return null;
  }

  const ageNote = drift.oldestOrphanedTempAt ? ` (oldest: ${drift.oldestOrphanedTempAt})` : "";

  return {
    id: nextActionId("cleanup-orphaned-tmp"),
    kind: "cleanup-orphaned-tmp",
    tier: 0,
    label: "Remove orphaned temp files",
    description: `Delete ${drift.orphanedTempCount} orphaned .tmp file(s) from crashed atomic writes${ageNote}. These are incomplete write artifacts that serve no purpose.`,
    reason: "Orphaned temp files detected in session directory",
    estimatedImpact: {
      affectedCount: drift.orphanedTempCount,
      estimatedBytes: storage.orphanedTempBytes,
      affectedClasses: [],
    },
    reversible: false, // .tmp files are garbage; no need to archive
    prerequisites: [],
  };
}

function buildArchiveOrphanTranscripts(
  snapshot: SessionHealthRawSnapshot,
): RemediationAction | null {
  const { drift } = snapshot;
  if (drift.diskFilesWithoutIndex === 0) {
    return null;
  }

  return {
    id: nextActionId("archive-orphan-transcripts"),
    kind: "archive-orphan-transcripts",
    tier: 1,
    label: "Archive orphan transcript files",
    description: `Rename ${drift.diskFilesWithoutIndex} .jsonl file(s) that are not referenced by any session index entry to .deleted.<timestamp>. Original files are preserved for the configured deleted-artifact retention window.`,
    reason: "Disk files found without matching session index entry (index drift)",
    estimatedImpact: {
      affectedCount: drift.diskFilesWithoutIndex,
      // We don't have per-file byte data in the snapshot; estimate from active transcript average
      estimatedBytes: estimateOrphanTranscriptBytes(snapshot),
      affectedClasses: [],
    },
    reversible: true,
    prerequisites: [],
  };
}

function estimateOrphanTranscriptBytes(snapshot: SessionHealthRawSnapshot): number {
  const activeCount = snapshot.sessions.byDiskState.active;
  const activeBytes = snapshot.storage.activeTranscriptBytes;
  if (activeCount === 0) {
    return 0;
  }
  const avgBytes = activeBytes / activeCount;
  return Math.round(avgBytes * snapshot.drift.diskFilesWithoutIndex);
}

function buildArchiveStaleDeletedTranscripts(
  snapshot: SessionHealthRawSnapshot,
): RemediationAction | null {
  const { storage, sessions } = snapshot;
  if (sessions.byDiskState.deleted === 0 || storage.deletedTranscriptBytes === 0) {
    return null;
  }

  return {
    id: nextActionId("archive-stale-deleted-transcripts"),
    kind: "archive-stale-deleted-transcripts",
    tier: 1,
    label: "Purge aged .deleted transcript archives",
    description: `Remove ${sessions.byDiskState.deleted} soft-deleted transcript file(s) that have exceeded their archive retention window (${formatMs(snapshot.maintenance.pruneAfterMs)}). These are already-deleted session transcripts that were retained as safety backups.`,
    reason: "Stale .deleted transcript archives consuming storage",
    estimatedImpact: {
      affectedCount: sessions.byDiskState.deleted,
      estimatedBytes: storage.deletedTranscriptBytes,
      affectedClasses: [],
    },
    reversible: false, // These are already the archived version
    prerequisites: [],
  };
}

function buildArchiveStaleResetTranscripts(
  snapshot: SessionHealthRawSnapshot,
): RemediationAction | null {
  const { storage, sessions } = snapshot;
  if (sessions.byDiskState.reset === 0 || storage.resetTranscriptBytes === 0) {
    return null;
  }

  const totalBytes = storage.totalManagedBytes;
  const resetPct =
    totalBytes > 0 ? ((storage.resetTranscriptBytes / totalBytes) * 100).toFixed(0) : "0";

  return {
    id: nextActionId("archive-stale-reset-transcripts"),
    kind: "archive-stale-reset-transcripts",
    tier: 1,
    label: "Purge aged .reset transcript archives",
    description: `Remove ${sessions.byDiskState.reset} reset transcript file(s) consuming ${formatBytes(storage.resetTranscriptBytes)} (${resetPct}% of total managed storage). These are session-reset snapshots retained for recovery.`,
    reason: "Reset transcript archives are the dominant storage consumer",
    estimatedImpact: {
      affectedCount: sessions.byDiskState.reset,
      estimatedBytes: storage.resetTranscriptBytes,
      affectedClasses: [],
    },
    reversible: false, // These are already the archived version
    prerequisites: [],
  };
}

function buildReconcileIndexPhantoms(snapshot: SessionHealthRawSnapshot): RemediationAction | null {
  const { drift } = snapshot;
  if (drift.indexedWithoutDiskFile === 0) {
    return null;
  }

  return {
    id: nextActionId("reconcile-index-phantoms"),
    kind: "reconcile-index-phantoms",
    tier: 2,
    label: "Remove phantom index entries",
    description: `Remove ${drift.indexedWithoutDiskFile} session index entry/entries that reference transcript files no longer on disk. These phantom entries inflate the session list and prevent accurate health metrics.`,
    reason: "Index entries found without matching disk file (index drift)",
    estimatedImpact: {
      affectedCount: drift.indexedWithoutDiskFile,
      estimatedBytes: 0, // Index compaction savings are minimal
      affectedClasses: [],
    },
    reversible: false, // Index entry removal is not reversible, but the transcript is already gone
    prerequisites: ["archive-orphan-transcripts"], // Reconcile after orphan archival to avoid double-counting
  };
}

function buildPruneStaleSessionsByClass(
  snapshot: SessionHealthRawSnapshot,
  sessionClass: SessionHealthClass,
  retentionMs: number,
): RemediationAction | null {
  const count = snapshot.sessions.byClass[sessionClass];
  if (count === 0) {
    return null;
  }

  const kindMap: Partial<Record<SessionHealthClass, RemediationActionKind>> = {
    "cron-run": "prune-stale-cron-runs",
    subagent: "prune-stale-subagents",
    heartbeat: "prune-stale-heartbeats",
    acp: "prune-stale-acp",
  };

  const kind = kindMap[sessionClass];
  if (!kind) {
    return null;
  }

  const labelMap: Record<string, string> = {
    "cron-run": "cron run",
    subagent: "subagent",
    heartbeat: "heartbeat",
    acp: "ACP",
  };

  return {
    id: nextActionId(kind),
    kind,
    tier: 2,
    label: `Prune stale ${labelMap[sessionClass] ?? sessionClass} sessions`,
    description: `Remove session index entries for ${count} ${labelMap[sessionClass] ?? sessionClass} session(s) older than ${formatMs(retentionMs)} and their associated transcript files. This reduces index bloat from ephemeral session types.`,
    reason: `${count} ${labelMap[sessionClass] ?? sessionClass} session(s) in index (retention policy: ${formatMs(retentionMs)})`,
    estimatedImpact: {
      affectedCount: count,
      estimatedBytes: 0, // Would need per-class byte accounting to estimate
      affectedClasses: [sessionClass],
    },
    reversible: false,
    prerequisites: [],
  };
}

function buildEnforceDiskBudget(snapshot: SessionHealthRawSnapshot): RemediationAction | null {
  const { maintenance, storage } = snapshot;
  if (maintenance.maxDiskBytes == null || maintenance.usagePercent.diskBytes == null) {
    return null;
  }
  if (maintenance.usagePercent.diskBytes <= 100) {
    return null; // Not over budget
  }

  const overBytes = storage.totalManagedBytes - maintenance.maxDiskBytes;

  return {
    id: nextActionId("enforce-disk-budget"),
    kind: "enforce-disk-budget",
    tier: 3,
    label: "Enforce disk budget",
    description: `Session storage (${formatBytes(storage.totalManagedBytes)}) exceeds disk budget (${formatBytes(maintenance.maxDiskBytes)}). Would need to free ${formatBytes(overBytes)} by removing oldest artifacts and session entries.`,
    reason: `Disk budget exceeded (${maintenance.usagePercent.diskBytes.toFixed(0)}% of limit)`,
    estimatedImpact: {
      affectedCount: 0, // Cannot estimate without detailed sweep
      estimatedBytes: overBytes,
      affectedClasses: [],
    },
    reversible: false,
    prerequisites: [
      "cleanup-orphaned-tmp",
      "archive-stale-deleted-transcripts",
      "archive-stale-reset-transcripts",
    ],
  };
}

// ---------------------------------------------------------------------------
// Plan builder — the main pure function
// ---------------------------------------------------------------------------

/**
 * Build a complete remediation plan from a raw health snapshot.
 *
 * This is a PURE FUNCTION. It reads snapshot data and produces a plan.
 * It never touches disk, never deletes anything, never mutates state.
 *
 * @param options - Snapshot and optional overrides
 * @returns A structured plan describing what WOULD be cleaned and why
 */
export function buildRemediationPlan(options: BuildRemediationPlanOptions): RemediationPlan {
  actionIdCounter = 0; // Reset for deterministic IDs

  const { snapshot, retentionOverrides, includeNoOpActions } = options;

  // Resolve retention per class (merge overrides with defaults)
  const retention: Record<SessionHealthClass, number | null> = { ...DEFAULT_RETENTION_MS };
  if (retentionOverrides) {
    for (const [cls, ms] of Object.entries(retentionOverrides)) {
      if (ms != null) {
        retention[cls as SessionHealthClass] = ms;
      }
    }
  }

  // Build all candidate actions
  const allActions: (RemediationAction | null)[] = [
    // Tier 0
    buildCleanupOrphanedTmp(snapshot),

    // Tier 1
    buildArchiveOrphanTranscripts(snapshot),
    buildArchiveStaleDeletedTranscripts(snapshot),
    buildArchiveStaleResetTranscripts(snapshot),

    // Tier 2
    buildReconcileIndexPhantoms(snapshot),
    ...buildPruneStaleClassActions(snapshot, retention),

    // Tier 3
    buildEnforceDiskBudget(snapshot),
  ];

  // Filter to non-null actions; optionally include zero-impact actions
  const actions = allActions.filter((a): a is RemediationAction => {
    if (a == null) {
      return false;
    }
    if (
      !includeNoOpActions &&
      a.estimatedImpact.affectedCount === 0 &&
      a.estimatedImpact.estimatedBytes === 0
    ) {
      return false;
    }
    return true;
  });

  // Group by tier
  const tiers = buildTierGroups(actions);

  // Compute summary
  const summary = buildPlanSummary(actions);

  // Build approval model
  const approvalModel = buildApprovalModel();

  return {
    generatedAt: new Date().toISOString(),
    snapshotAt: snapshot.capturedAt,
    summary,
    tiers,
    approvalModel,
  };
}

function buildPruneStaleClassActions(
  snapshot: SessionHealthRawSnapshot,
  retention: Record<SessionHealthClass, number | null>,
): (RemediationAction | null)[] {
  const pruneClasses: SessionHealthClass[] = ["cron-run", "subagent", "heartbeat", "acp"];
  return pruneClasses.map((cls) => {
    const retentionMs = retention[cls];
    if (retentionMs == null) {
      return null;
    }
    return buildPruneStaleSessionsByClass(snapshot, cls, retentionMs);
  });
}

function buildTierGroups(actions: RemediationAction[]): RemediationTierGroup[] {
  const tierMap = new Map<RemediationRiskTier, RemediationAction[]>();

  for (const action of actions) {
    const existing = tierMap.get(action.tier) ?? [];
    existing.push(action);
    tierMap.set(action.tier, existing);
  }

  const tiers: RemediationTierGroup[] = [];
  for (const tier of [0, 1, 2, 3] as RemediationRiskTier[]) {
    const tierActions = tierMap.get(tier);
    if (!tierActions || tierActions.length === 0) {
      continue;
    }
    tiers.push({
      tier,
      label: REMEDIATION_TIER_LABELS[tier],
      description: REMEDIATION_TIER_DESCRIPTIONS[tier],
      approvalRequired: tier >= 2,
      actions: tierActions,
    });
  }

  return tiers;
}

function buildPlanSummary(actions: RemediationAction[]): RemediationPlanSummary {
  const countByTier: Record<RemediationRiskTier, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
  let estimatedRecoverableBytes = 0;
  let highestTier: RemediationRiskTier = 0;

  for (const action of actions) {
    countByTier[action.tier]++;
    estimatedRecoverableBytes += action.estimatedImpact.estimatedBytes;
    if (action.tier > highestTier) {
      highestTier = action.tier;
    }
  }

  const recommendation = buildRecommendation(actions, countByTier, estimatedRecoverableBytes);

  return {
    totalActions: actions.length,
    estimatedRecoverableBytes,
    actionCountByTier: countByTier,
    highestTierRequired: highestTier,
    recommendation,
  };
}

function buildRecommendation(
  actions: RemediationAction[],
  countByTier: Record<RemediationRiskTier, number>,
  estimatedRecoverableBytes: number,
): string {
  if (actions.length === 0) {
    return "No remediation actions recommended. Session health is clean.";
  }

  const parts: string[] = [];

  if (countByTier[0] > 0) {
    parts.push(`${countByTier[0]} auto-safe action(s) can run immediately`);
  }
  if (countByTier[1] > 0) {
    parts.push(`${countByTier[1]} reversible action(s) should be previewed before enabling`);
  }
  if (countByTier[2] > 0) {
    parts.push(`${countByTier[2]} index-mutating action(s) require explicit approval`);
  }
  if (countByTier[3] > 0) {
    parts.push(`${countByTier[3]} destructive action(s) require manual review and confirmation`);
  }

  if (estimatedRecoverableBytes > 0) {
    parts.push(`Estimated recoverable: ${formatBytes(estimatedRecoverableBytes)}`);
  }

  return parts.join(". ") + ".";
}

function buildApprovalModel(): ApprovalModel {
  const autoApprovable: RemediationActionKind[] = [];
  const previewThenAutomate: RemediationActionKind[] = [];
  const explicitApprovalRequired: RemediationActionKind[] = [];
  const neverAutomate: RemediationActionKind[] = [];

  for (const [kind, tier] of Object.entries(ACTION_KIND_TIERS) as [
    RemediationActionKind,
    RemediationRiskTier,
  ][]) {
    switch (tier) {
      case 0:
        autoApprovable.push(kind);
        break;
      case 1:
        previewThenAutomate.push(kind);
        break;
      case 2:
        explicitApprovalRequired.push(kind);
        break;
      case 3:
        neverAutomate.push(kind);
        break;
    }
  }

  return {
    autoApprovable,
    previewThenAutomate,
    explicitApprovalRequired,
    neverAutomate,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

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

function formatMs(ms: number): string {
  const days = ms / (24 * 60 * 60 * 1000);
  if (days >= 1) {
    return `${Math.round(days)}d`;
  }
  const hours = ms / (60 * 60 * 1000);
  if (hours >= 1) {
    return `${Math.round(hours)}h`;
  }
  return `${Math.round(ms / 60_000)}m`;
}

// ---------------------------------------------------------------------------
// Plan renderer (human-readable text output for CLI / dry-run reports)
// ---------------------------------------------------------------------------

/**
 * Render a remediation plan as a human-readable text report.
 *
 * Suitable for CLI output, dry-run previews, and operator review.
 */
export function renderRemediationPlanText(plan: RemediationPlan): string {
  const lines: string[] = [];

  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("  SESSION HEALTH — REMEDIATION PLAN (DRY RUN)");
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("");
  lines.push(`  Generated:  ${plan.generatedAt}`);
  lines.push(`  Snapshot:   ${plan.snapshotAt}`);
  lines.push(`  Actions:    ${plan.summary.totalActions}`);
  lines.push(`  Estimated:  ${formatBytes(plan.summary.estimatedRecoverableBytes)} recoverable`);
  lines.push("");
  lines.push(`  ${plan.summary.recommendation}`);
  lines.push("");

  if (plan.tiers.length === 0) {
    lines.push("  ✓ No remediation actions needed.");
    lines.push("");
    return lines.join("\n");
  }

  for (const tierGroup of plan.tiers) {
    const approvalNote = tierGroup.approvalRequired ? " [REQUIRES APPROVAL]" : " [auto-safe]";
    lines.push(`── Tier ${tierGroup.tier}: ${tierGroup.label}${approvalNote} ──`);
    lines.push(`   ${tierGroup.description}`);
    lines.push("");

    for (const action of tierGroup.actions) {
      const reversibleTag = action.reversible ? " [reversible]" : "";
      lines.push(`  ▸ ${action.label}${reversibleTag}`);
      lines.push(`    ${action.description}`);
      lines.push(`    Reason: ${action.reason}`);
      if (action.estimatedImpact.affectedCount > 0 || action.estimatedImpact.estimatedBytes > 0) {
        const parts: string[] = [];
        if (action.estimatedImpact.affectedCount > 0) {
          parts.push(`${action.estimatedImpact.affectedCount} artifact(s)`);
        }
        if (action.estimatedImpact.estimatedBytes > 0) {
          parts.push(formatBytes(action.estimatedImpact.estimatedBytes));
        }
        lines.push(`    Impact: ${parts.join(", ")}`);
      }
      if (action.prerequisites.length > 0) {
        lines.push(`    Prerequisite: ${action.prerequisites.join(", ")}`);
      }
      lines.push("");
    }
  }

  lines.push("── Approval Model ──");
  lines.push("");
  if (plan.approvalModel.autoApprovable.length > 0) {
    lines.push("  Auto-safe (can automate without approval):");
    for (const kind of plan.approvalModel.autoApprovable) {
      lines.push(`    • ${kind}`);
    }
    lines.push("");
  }
  if (plan.approvalModel.previewThenAutomate.length > 0) {
    lines.push("  Preview-then-automate (dry-run first, then automate):");
    for (const kind of plan.approvalModel.previewThenAutomate) {
      lines.push(`    • ${kind}`);
    }
    lines.push("");
  }
  if (plan.approvalModel.explicitApprovalRequired.length > 0) {
    lines.push("  Explicit approval (requires confirmation per execution):");
    for (const kind of plan.approvalModel.explicitApprovalRequired) {
      lines.push(`    • ${kind}`);
    }
    lines.push("");
  }
  if (plan.approvalModel.neverAutomate.length > 0) {
    lines.push("  Never automate (always manual review + confirmation):");
    for (const kind of plan.approvalModel.neverAutomate) {
      lines.push(`    • ${kind}`);
    }
    lines.push("");
  }

  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("  THIS IS A DRY-RUN REPORT. No changes have been made.");
  lines.push("═══════════════════════════════════════════════════════════════");

  return lines.join("\n");
}
