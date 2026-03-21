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
import { DEFAULT_CLASS_RETENTION_MS } from "./session-health-types.js";

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
  const { storage, sessions, staleArtifacts } = snapshot;
  if (sessions.byDiskState.deleted === 0 || storage.deletedTranscriptBytes === 0) {
    return null;
  }

  // Use retention-filtered counts when available (honest count of files
  // actually past the retention window). Fall back to total disk-state counts
  // for snapshots collected before the staleArtifacts field was added.
  const staleCount = staleArtifacts?.staleDeletedCount ?? sessions.byDiskState.deleted;
  const staleBytes = staleArtifacts?.staleDeletedBytes ?? storage.deletedTranscriptBytes;

  if (staleCount === 0) {
    return null; // All .deleted files are still within retention
  }

  const withinRetention = sessions.byDiskState.deleted - staleCount;
  const retentionNote =
    withinRetention > 0 ? ` (${withinRetention} more within retention window, not affected)` : "";

  return {
    id: nextActionId("archive-stale-deleted-transcripts"),
    kind: "archive-stale-deleted-transcripts",
    tier: 1,
    label: "Purge aged .deleted transcript archives",
    description: `Permanently remove ${staleCount} .deleted transcript file(s) (${formatBytes(staleBytes)}) that have exceeded the archive retention window (${formatMs(snapshot.maintenance.pruneAfterMs)})${retentionNote}. These are already soft-deleted session transcripts kept as safety backups; the original sessions were previously removed from the index.`,
    reason: "Stale .deleted transcript archives consuming storage beyond retention window",
    estimatedImpact: {
      affectedCount: staleCount,
      estimatedBytes: staleBytes,
      affectedClasses: [],
    },
    reversible: false, // These are already the archived version — no further backup exists
    prerequisites: [],
  };
}

function buildArchiveStaleResetTranscripts(
  snapshot: SessionHealthRawSnapshot,
): RemediationAction | null {
  const { storage, sessions, staleArtifacts } = snapshot;
  if (sessions.byDiskState.reset === 0 || storage.resetTranscriptBytes === 0) {
    return null;
  }

  // Use retention-filtered counts when available (honest count of files
  // actually past the retention window). Fall back to total disk-state counts
  // for snapshots collected before the staleArtifacts field was added.
  const staleCount = staleArtifacts?.staleResetCount ?? sessions.byDiskState.reset;
  const staleBytes = staleArtifacts?.staleResetBytes ?? storage.resetTranscriptBytes;

  if (staleCount === 0) {
    return null; // All .reset files are still within retention
  }

  const totalBytes = storage.totalManagedBytes;
  const resetPct = totalBytes > 0 ? ((staleBytes / totalBytes) * 100).toFixed(0) : "0";

  const withinRetention = sessions.byDiskState.reset - staleCount;
  const retentionNote =
    withinRetention > 0 ? ` (${withinRetention} more within retention window, not affected)` : "";

  return {
    id: nextActionId("archive-stale-reset-transcripts"),
    kind: "archive-stale-reset-transcripts",
    tier: 1,
    label: "Purge aged .reset transcript archives",
    description: `Permanently remove ${staleCount} .reset transcript archive(s) consuming ${formatBytes(staleBytes)} (${resetPct}% of total managed storage)${retentionNote}. These are already archived session-reset snapshots retained for recovery and now recommended for final purge.`,
    reason: "Aged .reset transcript archives are the dominant storage consumer",
    estimatedImpact: {
      affectedCount: staleCount,
      estimatedBytes: staleBytes,
      affectedClasses: [],
    },
    reversible: false, // These are already the archived version — no further backup exists
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
      estimatedBytes: null, // Honest estimate unavailable from current snapshot
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
  const totalCount = snapshot.sessions.byClass[sessionClass];
  // Use age-filtered stale counts from the collector when available.
  // Fall back to 0 if staleByClass is absent or has no entry for this class —
  // never fall back to totalCount, which would overstate stale sessions.
  const staleCount = snapshot.sessions.staleByClass?.[sessionClass] ?? 0;

  if (staleCount === 0) {
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

  const humanLabel = labelMap[sessionClass] ?? sessionClass;
  const contextNote =
    totalCount > staleCount
      ? ` (${totalCount - staleCount} of ${totalCount} total are within retention)`
      : "";

  return {
    id: nextActionId(kind),
    kind,
    tier: 2,
    label: `Prune stale ${humanLabel} sessions`,
    description: `Remove session index entries for ${staleCount} ${humanLabel} session(s) older than ${formatMs(retentionMs)} and their associated transcript files${contextNote}. This reduces index bloat from ephemeral session types.`,
    reason: `${staleCount} of ${totalCount} ${humanLabel} session(s) exceed retention policy (${formatMs(retentionMs)})`,
    estimatedImpact: {
      affectedCount: staleCount,
      estimatedBytes: null, // Honest estimate unavailable without per-class byte accounting
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
  const retention: Record<SessionHealthClass, number | null> = { ...DEFAULT_CLASS_RETENTION_MS };
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
      (a.estimatedImpact.estimatedBytes ?? 0) === 0
    ) {
      return false;
    }
    return true;
  });

  // Group by tier
  const tiers = buildTierGroups(actions);

  // Compute summary
  const summary = buildPlanSummary(actions);

  // Build approval model — only include action kinds that are active in this plan
  const activeKinds = new Set(actions.map((a) => a.kind));
  const approvalModel = buildApprovalModel(activeKinds);

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
    estimatedRecoverableBytes += action.estimatedImpact.estimatedBytes ?? 0;
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
    parts.push(`${countByTier[0]} auto-safe action(s) safe to execute`);
  }
  if (countByTier[1] > 0) {
    parts.push(`${countByTier[1]} retention cleanup action(s) — review list before enabling`);
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

/**
 * Build the approval model. When `activeKinds` is provided, only include
 * action kinds that appear in the current plan — this avoids listing
 * inactive/irrelevant action kinds in the dry-run output, reducing noise
 * and improving operator trust.
 */
function buildApprovalModel(activeKinds?: Set<RemediationActionKind>): ApprovalModel {
  const autoApprovable: RemediationActionKind[] = [];
  const previewThenAutomate: RemediationActionKind[] = [];
  const explicitApprovalRequired: RemediationActionKind[] = [];
  const neverAutomate: RemediationActionKind[] = [];

  for (const [kind, tier] of Object.entries(ACTION_KIND_TIERS) as [
    RemediationActionKind,
    RemediationRiskTier,
  ][]) {
    // When filtering to active kinds, skip kinds not in the plan
    if (activeKinds && !activeKinds.has(kind)) {
      continue;
    }
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
  lines.push("  REMEDIATION PLAN (DRY RUN)");
  lines.push("  Lifecycle review — uses per-class retention, may differ from");
  lines.push("  the global age threshold in the maintenance preview above");
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
    const approvalNote = tierGroup.approvalRequired
      ? " [REQUIRES APPROVAL]"
      : tierGroup.tier === 0
        ? " [auto-safe]"
        : " [review list first]";
    lines.push(`── Tier ${tierGroup.tier}: ${tierGroup.label}${approvalNote} ──`);
    lines.push(`   ${tierGroup.description}`);
    lines.push("");

    for (const action of tierGroup.actions) {
      const reversibleTag = action.reversible ? " [reversible]" : "";
      lines.push(`  ▸ ${action.label}${reversibleTag}`);
      lines.push(`    ${action.description}`);
      lines.push(`    Reason: ${action.reason}`);
      if (
        action.estimatedImpact.affectedCount > 0 ||
        (action.estimatedImpact.estimatedBytes ?? 0) > 0 ||
        action.estimatedImpact.estimatedBytes == null
      ) {
        const parts: string[] = [];
        if (action.estimatedImpact.affectedCount > 0) {
          parts.push(`${action.estimatedImpact.affectedCount} artifact(s)`);
        }
        if ((action.estimatedImpact.estimatedBytes ?? 0) > 0) {
          parts.push(formatBytes(action.estimatedImpact.estimatedBytes ?? 0));
        } else if (action.estimatedImpact.estimatedBytes == null) {
          parts.push("byte estimate unavailable");
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
    lines.push("  Review-then-automate (review list before enabling automation):");
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
