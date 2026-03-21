/**
 * Session Health — Remediation Executor (Phase 3C)
 *
 * Executes reviewed remediation actions. The executor:
 * 1. Re-derives a fresh plan from a fresh snapshot
 * 2. Validates that requested action IDs still exist in the fresh plan
 * 3. Executes actions in tier order
 * 4. Returns a structured execution result with before/after reporting
 *
 * The executor is a domain-layer module: it validates and executes, but does
 * NOT handle CLI concerns (confirmation prompts, JSON vs text output, flag
 * conflict detection). Those belong in the CLI command layer.
 *
 * Hard safety boundaries:
 * - v1 supports Tier 0 and Tier 1 only (V1_MAX_EXECUTION_TIER = 1)
 * - No Tier 2 or Tier 3 execution
 * - Refuses unknown or resolved action IDs
 * - All v1 actions are idempotent
 */

import fs from "node:fs/promises";
import path from "node:path";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionStore } from "../config/sessions/store.js";
import { collectSessionHealth } from "./session-health-collector.js";
import {
  discoverOrphanedTmpFiles,
  discoverOrphanTranscripts,
  discoverStaleDeletedTranscripts,
  discoverStaleResetTranscripts,
  extractIndexedSessionIds,
} from "./session-health-file-discovery.js";
import { buildRemediationPlan } from "./session-health-remediation-plan.js";
import type {
  ActionExecutionResult,
  ExecutionResult,
  ExecutionSummary,
  RemediationAction,
  RemediationActionKind,
} from "./session-health-remediation-types.js";
import { V1_MAX_EXECUTION_TIER } from "./session-health-remediation-types.js";
import type { SessionHealthRawSnapshot } from "./session-health-types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExecuteRemediationOptions = {
  /** Action IDs to execute (from the plan). */
  actionIds: string[];

  /** Pre-resolved config (optional, for testing). */
  cfg?: OpenClawConfig;

  /** Pre-collected snapshot (optional, for testing/reuse). */
  snapshot?: SessionHealthRawSnapshot;
};

export type ExecutorValidationResult =
  | { valid: true; actions: RemediationAction[] }
  | { valid: false; error: string };

// ---------------------------------------------------------------------------
// Action executor registry
// ---------------------------------------------------------------------------

type ActionExecutorFn = (params: {
  action: RemediationAction;
  snapshot: SessionHealthRawSnapshot;
  sessionsDir: string;
  store: Record<string, unknown>;
}) => Promise<ActionExecutionResult>;

const ACTION_EXECUTORS: Partial<Record<RemediationActionKind, ActionExecutorFn>> = {
  "cleanup-orphaned-tmp": executeCleanupOrphanedTmp,
  "archive-orphan-transcripts": executeArchiveOrphanTranscripts,
  "archive-stale-deleted-transcripts": executeArchiveStaleDeletedTranscripts,
  "archive-stale-reset-transcripts": executeArchiveStaleResetTranscripts,
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate that requested action IDs can be executed against a fresh plan.
 * Returns the actions to execute or an error message.
 */
export function validateExecutionRequest(
  requestedIds: string[],
  freshPlan: ReturnType<typeof buildRemediationPlan>,
): ExecutorValidationResult {
  // Build a lookup of all actions in the fresh plan
  const planActions = new Map<string, RemediationAction>();
  for (const tier of freshPlan.tiers) {
    for (const action of tier.actions) {
      planActions.set(action.id, action);
    }
  }

  // Validate each requested ID
  const actionsToExecute: RemediationAction[] = [];
  for (const id of requestedIds) {
    const action = planActions.get(id);
    if (!action) {
      return {
        valid: false,
        error: `Action '${id}' not found in current plan. The underlying condition may have resolved. Re-run --dry-run.`,
      };
    }

    // Check tier boundary
    if (action.tier > V1_MAX_EXECUTION_TIER) {
      const tierLabel = action.tier === 2 ? "Index-Mutating" : "Destructive";
      return {
        valid: false,
        error: `Action '${id}' is Tier ${action.tier} (${tierLabel}). v1 only supports Tier 0–1 execution. Use --dry-run to review.`,
      };
    }

    // Check that we have an executor for this action kind
    if (!ACTION_EXECUTORS[action.kind]) {
      return {
        valid: false,
        error: `No executor available for action kind '${action.kind}'. This is an internal error.`,
      };
    }

    actionsToExecute.push(action);
  }

  if (actionsToExecute.length === 0) {
    return {
      valid: false,
      error: "All requested actions have resolved since the last dry-run. Nothing to execute.",
    };
  }

  return { valid: true, actions: actionsToExecute };
}

/**
 * Resolve action IDs for a tier-based execution request.
 * --execute-tier 1 means "execute all Tier 0 + Tier 1 actions" (cumulative).
 */
export function resolveActionIdsForTier(
  tier: number,
  freshPlan: ReturnType<typeof buildRemediationPlan>,
): string[] {
  const ids: string[] = [];
  for (const tierGroup of freshPlan.tiers) {
    if (tierGroup.tier <= tier) {
      for (const action of tierGroup.actions) {
        ids.push(action.id);
      }
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Core executor
// ---------------------------------------------------------------------------

/**
 * Execute reviewed remediation actions.
 *
 * This is the main entry point for Phase 3C execution.
 * It re-derives a fresh plan, validates, executes, and reports.
 */
export async function executeRemediation(
  options: ExecuteRemediationOptions,
): Promise<ExecutionResult> {
  const cfg = options.cfg ?? loadConfig();

  // 1. Re-collect a fresh snapshot
  const snapshot = options.snapshot ?? (await collectSessionHealth(cfg));

  // 2. Re-generate the plan
  const freshPlan = buildRemediationPlan({ snapshot });

  // 3. Validate requested actions against the fresh plan
  const validation = validateExecutionRequest(options.actionIds, freshPlan);
  if (!validation.valid) {
    throw new ExecutionRefusalError(validation.error);
  }

  const actionsToExecute = [...validation.actions];

  // 4. Sort actions: Tier 0 before Tier 1, then by plan order
  actionsToExecute.sort((a: RemediationAction, b: RemediationAction) => {
    if (a.tier !== b.tier) {
      return a.tier - b.tier;
    }
    return 0; // preserve plan order within tier
  });

  // 5. Resolve sessions directory and store for file operations
  const agentId = resolveDefaultAgentId(cfg);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  const sessionsDir = path.dirname(storePath);
  const store = loadSessionStore(storePath, { skipCache: true });

  // 6. Capture "before" storage
  const storageBefore = snapshot.storage.totalManagedBytes;

  // 7. Execute each action
  const results: ActionExecutionResult[] = [];
  for (const action of actionsToExecute) {
    const executor = ACTION_EXECUTORS[action.kind];
    if (!executor) {
      results.push({
        id: action.id,
        kind: action.kind,
        tier: action.tier,
        status: "refused",
        artifactsRemoved: 0,
        bytesFreed: 0,
        error: `No executor for action kind '${action.kind}'.`,
      });
      continue;
    }

    try {
      const result = await executor({
        action,
        snapshot,
        sessionsDir,
        store,
      });
      results.push(result);
    } catch (err) {
      results.push({
        id: action.id,
        kind: action.kind,
        tier: action.tier,
        status: "failed",
        artifactsRemoved: 0,
        bytesFreed: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 8. Re-collect snapshot for "after" storage measurement
  let storageAfter = storageBefore;
  try {
    const afterSnapshot = await collectSessionHealth(cfg);
    storageAfter = afterSnapshot.storage.totalManagedBytes;
  } catch {
    // Best-effort: fall back to subtracting freed bytes
    const totalFreed = results.reduce((sum, r) => sum + r.bytesFreed, 0);
    storageAfter = storageBefore - totalFreed;
  }

  // 9. Build summary
  const summary: ExecutionSummary = {
    executed: results.filter((r) => r.status === "complete").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failed: results.filter((r) => r.status === "failed").length,
    refused: results.filter((r) => r.status === "refused").length,
    totalBytesFreed: results.reduce((sum, r) => sum + r.bytesFreed, 0),
    storageBefore,
    storageAfter,
  };

  return {
    executedAt: new Date().toISOString(),
    actions: results,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Execution refusal error
// ---------------------------------------------------------------------------

export class ExecutionRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionRefusalError";
  }
}

// ---------------------------------------------------------------------------
// Individual action executors
// ---------------------------------------------------------------------------

/**
 * Tier 0: Delete orphaned .tmp files from crashed atomic writes.
 */
async function executeCleanupOrphanedTmp(params: {
  action: RemediationAction;
  snapshot: SessionHealthRawSnapshot;
  sessionsDir: string;
}): Promise<ActionExecutionResult> {
  const { action, sessionsDir } = params;
  const files = await discoverOrphanedTmpFiles(sessionsDir);

  if (files.length === 0) {
    return {
      id: action.id,
      kind: action.kind,
      tier: action.tier,
      status: "skipped",
      artifactsRemoved: 0,
      bytesFreed: 0,
      detail: "No orphaned .tmp files found (condition resolved).",
    };
  }

  let removed = 0;
  let bytesFreed = 0;
  const warnings: string[] = [];

  for (const file of files) {
    try {
      await fs.unlink(file.absolutePath);
      removed++;
      bytesFreed += file.size;
    } catch (err) {
      warnings.push(
        `Failed to remove ${file.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (removed === 0) {
    return {
      id: action.id,
      kind: action.kind,
      tier: action.tier,
      status: "failed",
      artifactsRemoved: 0,
      bytesFreed: 0,
      error: "All file removals failed.",
      warnings,
    };
  }

  return {
    id: action.id,
    kind: action.kind,
    tier: action.tier,
    status: "complete",
    artifactsRemoved: removed,
    bytesFreed,
    detail: `Removed ${removed} .tmp file(s).`,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * Tier 1: Rename orphan .jsonl files to .deleted.<timestamp>.
 * This is a reversible operation — files are renamed, not deleted.
 */
async function executeArchiveOrphanTranscripts(params: {
  action: RemediationAction;
  snapshot: SessionHealthRawSnapshot;
  sessionsDir: string;
  store: Record<string, unknown>;
}): Promise<ActionExecutionResult> {
  const { action, sessionsDir, store } = params;
  const indexedIds = extractIndexedSessionIds(store);
  const files = await discoverOrphanTranscripts(sessionsDir, indexedIds);

  if (files.length === 0) {
    return {
      id: action.id,
      kind: action.kind,
      tier: action.tier,
      status: "skipped",
      artifactsRemoved: 0,
      bytesFreed: 0,
      detail: "No orphan transcripts found (condition resolved).",
    };
  }

  let archived = 0;
  let bytesFreed = 0;
  const warnings: string[] = [];
  const timestamp = Date.now();

  for (const file of files) {
    try {
      const newName = file.name.replace(/\.jsonl$/, `.deleted.${timestamp}.jsonl`);
      const newPath = path.join(sessionsDir, newName);
      await fs.rename(file.absolutePath, newPath);
      archived++;
      // Renaming doesn't free disk space, but it removes the file from "active" accounting
      // bytesFreed stays 0 for reversible operations
    } catch (err) {
      warnings.push(
        `Failed to archive ${file.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (archived === 0) {
    return {
      id: action.id,
      kind: action.kind,
      tier: action.tier,
      status: "failed",
      artifactsRemoved: 0,
      bytesFreed: 0,
      error: "All archive operations failed.",
      warnings,
    };
  }

  return {
    id: action.id,
    kind: action.kind,
    tier: action.tier,
    status: "complete",
    artifactsRemoved: archived,
    bytesFreed, // 0 for rename operations
    detail: `Archived ${archived} orphan transcript(s) to .deleted.${timestamp}.jsonl.`,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * Tier 1: Permanently remove .deleted transcript files past retention.
 */
async function executeArchiveStaleDeletedTranscripts(params: {
  action: RemediationAction;
  snapshot: SessionHealthRawSnapshot;
  sessionsDir: string;
}): Promise<ActionExecutionResult> {
  const { action, snapshot, sessionsDir } = params;
  const retentionMs = snapshot.maintenance.pruneAfterMs;
  const files = await discoverStaleDeletedTranscripts(sessionsDir, retentionMs);

  if (files.length === 0) {
    return {
      id: action.id,
      kind: action.kind,
      tier: action.tier,
      status: "skipped",
      artifactsRemoved: 0,
      bytesFreed: 0,
      detail: "No stale .deleted transcript files found (condition resolved).",
    };
  }

  let removed = 0;
  let bytesFreed = 0;
  const warnings: string[] = [];

  for (const file of files) {
    try {
      await fs.unlink(file.absolutePath);
      removed++;
      bytesFreed += file.size;
    } catch (err) {
      warnings.push(
        `Failed to remove ${file.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (removed === 0) {
    return {
      id: action.id,
      kind: action.kind,
      tier: action.tier,
      status: "failed",
      artifactsRemoved: 0,
      bytesFreed: 0,
      error: "All file removals failed.",
      warnings,
    };
  }

  return {
    id: action.id,
    kind: action.kind,
    tier: action.tier,
    status: "complete",
    artifactsRemoved: removed,
    bytesFreed,
    detail: `Removed ${removed} stale .deleted file(s).`,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * Tier 1: Permanently remove .reset transcript archives past retention.
 */
async function executeArchiveStaleResetTranscripts(params: {
  action: RemediationAction;
  snapshot: SessionHealthRawSnapshot;
  sessionsDir: string;
}): Promise<ActionExecutionResult> {
  const { action, snapshot, sessionsDir } = params;
  const retentionMs = snapshot.maintenance.pruneAfterMs;
  const files = await discoverStaleResetTranscripts(sessionsDir, retentionMs);

  if (files.length === 0) {
    return {
      id: action.id,
      kind: action.kind,
      tier: action.tier,
      status: "skipped",
      artifactsRemoved: 0,
      bytesFreed: 0,
      detail: "No stale .reset transcript files found (condition resolved).",
    };
  }

  let removed = 0;
  let bytesFreed = 0;
  const warnings: string[] = [];

  for (const file of files) {
    try {
      await fs.unlink(file.absolutePath);
      removed++;
      bytesFreed += file.size;
    } catch (err) {
      warnings.push(
        `Failed to remove ${file.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (removed === 0) {
    return {
      id: action.id,
      kind: action.kind,
      tier: action.tier,
      status: "failed",
      artifactsRemoved: 0,
      bytesFreed: 0,
      error: "All file removals failed.",
      warnings,
    };
  }

  return {
    id: action.id,
    kind: action.kind,
    tier: action.tier,
    status: "complete",
    artifactsRemoved: removed,
    bytesFreed,
    detail: `Removed ${removed} stale .reset file(s).`,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

// ---------------------------------------------------------------------------
// Confirmation prompt rendering
// ---------------------------------------------------------------------------

/**
 * Build the text confirmation block shown before execution.
 */
export function renderConfirmationBlock(actions: RemediationAction[]): string {
  const lines: string[] = [];

  lines.push("══════════════════════════════════════════════════════════");
  lines.push("  REMEDIATION EXECUTION — CONFIRMATION REQUIRED");
  lines.push("══════════════════════════════════════════════════════════");
  lines.push("");
  lines.push("  Actions to execute:");
  lines.push("");

  let totalArtifacts = 0;
  let totalBytes = 0;

  for (const action of actions) {
    const tierLabel =
      action.tier === 0
        ? "Tier 0, auto-safe"
        : action.tier === 1
          ? "Tier 1, retention cleanup"
          : `Tier ${action.tier}`;
    lines.push(`  ▸ ${action.id} [${tierLabel}]`);
    lines.push(`    ${action.description}`);

    const impactParts: string[] = [];
    if (action.estimatedImpact.affectedCount > 0) {
      impactParts.push(`${action.estimatedImpact.affectedCount} artifact(s)`);
      totalArtifacts += action.estimatedImpact.affectedCount;
    }
    if ((action.estimatedImpact.estimatedBytes ?? 0) > 0) {
      impactParts.push(formatBytes(action.estimatedImpact.estimatedBytes ?? 0));
      totalBytes += action.estimatedImpact.estimatedBytes ?? 0;
    }
    if (impactParts.length > 0) {
      lines.push(`    Impact: ${impactParts.join(", ")}`);
    }
    lines.push("");
  }

  const summaryParts: string[] = [`${actions.length} action(s)`];
  if (totalArtifacts > 0) {
    summaryParts.push(`${totalArtifacts} artifact(s)`);
  }
  if (totalBytes > 0) {
    summaryParts.push(`~${formatBytes(totalBytes)}`);
  }
  lines.push(`  Total: ${summaryParts.join(", ")}`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Render the execution result report (text mode).
 */
export function renderExecutionReportText(result: ExecutionResult): string {
  const lines: string[] = [];

  lines.push("══════════════════════════════════════════════════════════");
  lines.push("  REMEDIATION EXECUTION — COMPLETE");
  lines.push("══════════════════════════════════════════════════════════");
  lines.push("");
  lines.push(`  Executed: ${result.summary.executed} action(s)`);
  lines.push(`  Skipped:  ${result.summary.skipped}`);
  lines.push(`  Failed:   ${result.summary.failed}`);
  if (result.summary.refused > 0) {
    lines.push(`  Refused:  ${result.summary.refused}`);
  }
  lines.push("");

  for (const action of result.actions) {
    lines.push(`  ── ${action.id} ──`);

    const statusIcon =
      action.status === "complete"
        ? "✓"
        : action.status === "skipped"
          ? "○"
          : action.status === "refused"
            ? "✕"
            : "✗";
    lines.push(`  Status:   ${statusIcon} ${action.status}`);

    if (action.detail) {
      lines.push(`  Detail:   ${action.detail}`);
    }
    if (action.artifactsRemoved > 0) {
      lines.push(`  Removed:  ${action.artifactsRemoved} artifact(s)`);
    }
    if (action.bytesFreed > 0) {
      lines.push(`  Freed:    ${formatBytes(action.bytesFreed)}`);
    }
    if (action.error) {
      lines.push(`  Error:    ${action.error}`);
    }
    if (action.warnings && action.warnings.length > 0) {
      for (const w of action.warnings) {
        lines.push(`  Warning:  ${w}`);
      }
    }
    lines.push("");
  }

  lines.push("  ── Storage Summary ──");
  lines.push(`  Before:   ${formatBytes(result.summary.storageBefore)} total managed`);
  lines.push(`  After:    ${formatBytes(result.summary.storageAfter)} total managed`);
  const freed = result.summary.storageBefore - result.summary.storageAfter;
  if (freed > 0) {
    const pct =
      result.summary.storageBefore > 0
        ? ((freed / result.summary.storageBefore) * 100).toFixed(1)
        : "0.0";
    lines.push(`  Freed:    ${formatBytes(freed)} (${pct}%)`);
  } else {
    lines.push(`  Freed:    0 B`);
  }
  lines.push("");
  lines.push("══════════════════════════════════════════════════════════");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Formatting helpers (local — same as in remediation-plan.ts)
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
