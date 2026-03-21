import fs from "node:fs";
import { promptYesNo } from "../cli/prompt.js";
import { loadConfig } from "../config/config.js";
import {
  capEntryCount,
  enforceSessionDiskBudget,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  loadSessionStore,
  pruneStaleEntries,
  resolveMaintenanceConfig,
  updateSessionStore,
  type SessionEntry,
  type SessionMaintenanceApplyReport,
} from "../config/sessions.js";
import { collectSessionHealth } from "../infra/session-health-collector.js";
import {
  executeRemediation,
  ExecutionRefusalError,
  renderConfirmationBlock,
  renderExecutionReportText,
  resolveActionIdsForTier,
  validateExecutionRequest,
} from "../infra/session-health-remediation-executor.js";
import {
  buildRemediationPlan,
  renderRemediationPlanText,
} from "../infra/session-health-remediation-plan.js";
import type { RemediationPlan } from "../infra/session-health-remediation-types.js";
import { V1_MAX_EXECUTION_TIER } from "../infra/session-health-remediation-types.js";
import type { RuntimeEnv } from "../runtime.js";
import { isRich, theme } from "../terminal/theme.js";
import {
  resolveSessionStoreTargetsOrExit,
  type SessionStoreTarget,
} from "./session-store-targets.js";
import {
  formatSessionAgeCell,
  formatSessionFlagsCell,
  formatSessionKeyCell,
  formatSessionModelCell,
  resolveSessionDisplayDefaults,
  resolveSessionDisplayModel,
  SESSION_AGE_PAD,
  SESSION_KEY_PAD,
  SESSION_MODEL_PAD,
  toSessionDisplayRows,
} from "./sessions-table.js";

export type SessionsCleanupOptions = {
  store?: string;
  agent?: string;
  allAgents?: boolean;
  dryRun?: boolean;
  enforce?: boolean;
  activeKey?: string;
  json?: boolean;
  fixMissing?: boolean;
  execute?: string[];
  executeTier?: string;
  yes?: boolean;
};

type SessionCleanupAction =
  | "keep"
  | "prune-missing"
  | "prune-stale"
  | "cap-overflow"
  | "evict-budget";

const ACTION_PAD = 12;

type SessionCleanupActionRow = ReturnType<typeof toSessionDisplayRows>[number] & {
  action: SessionCleanupAction;
};

type SessionCleanupSummary = {
  agentId: string;
  storePath: string;
  mode: "warn" | "enforce";
  dryRun: boolean;
  beforeCount: number;
  afterCount: number;
  missing: number;
  pruned: number;
  capped: number;
  diskBudget: Awaited<ReturnType<typeof enforceSessionDiskBudget>>;
  wouldMutate: boolean;
  applied?: true;
  appliedCount?: number;
};

function resolveSessionCleanupAction(params: {
  key: string;
  missingKeys: Set<string>;
  staleKeys: Set<string>;
  cappedKeys: Set<string>;
  budgetEvictedKeys: Set<string>;
}): SessionCleanupAction {
  if (params.missingKeys.has(params.key)) {
    return "prune-missing";
  }
  if (params.staleKeys.has(params.key)) {
    return "prune-stale";
  }
  if (params.cappedKeys.has(params.key)) {
    return "cap-overflow";
  }
  if (params.budgetEvictedKeys.has(params.key)) {
    return "evict-budget";
  }
  return "keep";
}

function formatCleanupActionCell(action: SessionCleanupAction, rich: boolean): string {
  const label = action.padEnd(ACTION_PAD);
  if (!rich) {
    return label;
  }
  if (action === "keep") {
    return theme.muted(label);
  }
  if (action === "prune-missing") {
    return theme.error(label);
  }
  if (action === "prune-stale") {
    return theme.warn(label);
  }
  if (action === "cap-overflow") {
    return theme.accentBright(label);
  }
  return theme.error(label);
}

function buildActionRows(params: {
  beforeStore: Record<string, SessionEntry>;
  missingKeys: Set<string>;
  staleKeys: Set<string>;
  cappedKeys: Set<string>;
  budgetEvictedKeys: Set<string>;
}): SessionCleanupActionRow[] {
  return toSessionDisplayRows(params.beforeStore).map((row) => ({
    ...row,
    action: resolveSessionCleanupAction({
      key: row.key,
      missingKeys: params.missingKeys,
      staleKeys: params.staleKeys,
      cappedKeys: params.cappedKeys,
      budgetEvictedKeys: params.budgetEvictedKeys,
    }),
  }));
}

function pruneMissingTranscriptEntries(params: {
  store: Record<string, SessionEntry>;
  storePath: string;
  onPruned?: (key: string) => void;
}): number {
  const sessionPathOpts = resolveSessionFilePathOptions({
    storePath: params.storePath,
  });
  let removed = 0;
  for (const [key, entry] of Object.entries(params.store)) {
    if (!entry?.sessionId) {
      continue;
    }
    const transcriptPath = resolveSessionFilePath(entry.sessionId, entry, sessionPathOpts);
    if (!fs.existsSync(transcriptPath)) {
      delete params.store[key];
      removed += 1;
      params.onPruned?.(key);
    }
  }
  return removed;
}

async function previewStoreCleanup(params: {
  target: SessionStoreTarget;
  mode: "warn" | "enforce";
  dryRun: boolean;
  activeKey?: string;
  fixMissing?: boolean;
}) {
  const maintenance = resolveMaintenanceConfig();
  const beforeStore = loadSessionStore(params.target.storePath, { skipCache: true });
  const previewStore = structuredClone(beforeStore);
  const staleKeys = new Set<string>();
  const cappedKeys = new Set<string>();
  const missingKeys = new Set<string>();
  const missing =
    params.fixMissing === true
      ? pruneMissingTranscriptEntries({
          store: previewStore,
          storePath: params.target.storePath,
          onPruned: (key) => {
            missingKeys.add(key);
          },
        })
      : 0;
  const pruned = pruneStaleEntries(previewStore, maintenance.pruneAfterMs, {
    log: false,
    onPruned: ({ key }) => {
      staleKeys.add(key);
    },
  });
  const capped = capEntryCount(previewStore, maintenance.maxEntries, {
    log: false,
    onCapped: ({ key }) => {
      cappedKeys.add(key);
    },
  });
  const beforeBudgetStore = structuredClone(previewStore);
  const diskBudget = await enforceSessionDiskBudget({
    store: previewStore,
    storePath: params.target.storePath,
    activeSessionKey: params.activeKey,
    maintenance,
    warnOnly: false,
    dryRun: true,
  });
  const budgetEvictedKeys = new Set<string>();
  for (const key of Object.keys(beforeBudgetStore)) {
    if (!Object.hasOwn(previewStore, key)) {
      budgetEvictedKeys.add(key);
    }
  }
  const beforeCount = Object.keys(beforeStore).length;
  const afterPreviewCount = Object.keys(previewStore).length;
  const wouldMutate =
    missing > 0 ||
    pruned > 0 ||
    capped > 0 ||
    Boolean((diskBudget?.removedEntries ?? 0) > 0 || (diskBudget?.removedFiles ?? 0) > 0);

  const summary: SessionCleanupSummary = {
    agentId: params.target.agentId,
    storePath: params.target.storePath,
    mode: params.mode,
    dryRun: params.dryRun,
    beforeCount,
    afterCount: afterPreviewCount,
    missing,
    pruned,
    capped,
    diskBudget,
    wouldMutate,
  };

  return {
    summary,
    actionRows: buildActionRows({
      beforeStore,
      staleKeys,
      cappedKeys,
      budgetEvictedKeys,
      missingKeys,
    }),
  };
}

function renderStoreDryRunPlan(params: {
  cfg: ReturnType<typeof loadConfig>;
  summary: SessionCleanupSummary;
  actionRows: SessionCleanupActionRow[];
  displayDefaults: ReturnType<typeof resolveSessionDisplayDefaults>;
  runtime: RuntimeEnv;
  showAgentHeader: boolean;
}) {
  const rich = isRich();
  if (params.showAgentHeader) {
    params.runtime.log(`Agent: ${params.summary.agentId}`);
  }
  params.runtime.log(`Session store: ${params.summary.storePath}`);
  params.runtime.log("");
  const sectionLabel = "── Maintenance Preview (global age threshold) ──";
  params.runtime.log(rich ? theme.heading(sectionLabel) : sectionLabel);
  params.runtime.log(`Maintenance mode: ${params.summary.mode}`);
  params.runtime.log(
    `Entries: ${params.summary.beforeCount} -> ${params.summary.afterCount} (remove ${params.summary.beforeCount - params.summary.afterCount})`,
  );
  params.runtime.log(`Would prune missing transcripts: ${params.summary.missing}`);
  params.runtime.log(
    `Would prune stale (global age threshold, all classes): ${params.summary.pruned}`,
  );
  params.runtime.log(`Would cap overflow: ${params.summary.capped}`);
  if (params.summary.diskBudget) {
    params.runtime.log(
      `Would enforce disk budget: ${params.summary.diskBudget.totalBytesBefore} -> ${params.summary.diskBudget.totalBytesAfter} bytes (files ${params.summary.diskBudget.removedFiles}, entries ${params.summary.diskBudget.removedEntries})`,
    );
  }
  if (params.actionRows.length === 0) {
    return;
  }
  params.runtime.log("");
  params.runtime.log("Planned session actions:");
  const header = [
    "Action".padEnd(ACTION_PAD),
    "Key".padEnd(SESSION_KEY_PAD),
    "Age".padEnd(SESSION_AGE_PAD),
    "Model".padEnd(SESSION_MODEL_PAD),
    "Flags",
  ].join(" ");
  params.runtime.log(rich ? theme.heading(header) : header);
  for (const actionRow of params.actionRows) {
    const model = resolveSessionDisplayModel(params.cfg, actionRow, params.displayDefaults);
    const line = [
      formatCleanupActionCell(actionRow.action, rich),
      formatSessionKeyCell(actionRow.key, rich),
      formatSessionAgeCell(actionRow.updatedAt, rich),
      formatSessionModelCell(model, rich),
      formatSessionFlagsCell(actionRow, rich),
    ].join(" ");
    params.runtime.log(line.trimEnd());
  }
}

/**
 * Attempt to collect a health snapshot and build a remediation plan.
 * Best-effort: returns null if collection fails (e.g., no config, no disk).
 * This is intentionally non-blocking for the existing dry-run flow.
 */
async function tryBuildRemediationPlanForDryRun(
  cfg: ReturnType<typeof loadConfig>,
): Promise<RemediationPlan | null> {
  try {
    const snapshot = await collectSessionHealth(cfg);
    return buildRemediationPlan({ snapshot });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Execution sub-command (Phase 3C)
// ---------------------------------------------------------------------------

async function sessionsCleanupExecuteCommand(
  opts: SessionsCleanupOptions,
  cfg: ReturnType<typeof loadConfig>,
  runtime: RuntimeEnv,
) {
  const hasExecuteTier = opts.executeTier != null && opts.executeTier !== "";

  try {
    // 1. Re-collect fresh snapshot and plan
    const snapshot = await collectSessionHealth(cfg);
    const freshPlan = buildRemediationPlan({ snapshot });

    // 2. Resolve action IDs
    let actionIds: string[];
    if (hasExecuteTier) {
      const tierNum = Number(opts.executeTier);
      if (!Number.isInteger(tierNum) || tierNum < 0) {
        runtime.error(`--execute-tier must be a non-negative integer. Got: '${opts.executeTier}'.`);
        runtime.exit(1);
        return;
      }
      if (tierNum > V1_MAX_EXECUTION_TIER) {
        runtime.error(
          `--execute-tier ${tierNum} is not supported in v1. Maximum: ${V1_MAX_EXECUTION_TIER}.`,
        );
        runtime.exit(1);
        return;
      }
      actionIds = resolveActionIdsForTier(tierNum, freshPlan);
      if (actionIds.length === 0) {
        if (opts.json) {
          runtime.log(
            JSON.stringify(
              {
                executedAt: new Date().toISOString(),
                actions: [],
                summary: {
                  executed: 0,
                  skipped: 0,
                  failed: 0,
                  refused: 0,
                  totalBytesFreed: 0,
                  storageBefore: snapshot.storage.totalManagedBytes,
                  storageAfter: snapshot.storage.totalManagedBytes,
                },
                message: `No Tier 0–${tierNum} actions in the current plan. Nothing to execute.`,
              },
              null,
              2,
            ),
          );
        } else {
          runtime.log(`No Tier 0–${tierNum} actions in the current plan. Nothing to execute.`);
        }
        return;
      }
    } else {
      actionIds = opts.execute ?? [];
    }

    // 3. Validate against fresh plan
    const validation = validateExecutionRequest(actionIds, freshPlan);
    if (!validation.valid) {
      runtime.error(validation.error);
      runtime.exit(1);
      return;
    }

    // 4. Show confirmation prompt (suppress human text when --json for clean stdout)
    if (!opts.json) {
      const confirmationText = renderConfirmationBlock(validation.actions);
      runtime.log(confirmationText);
    }

    if (!opts.yes) {
      const confirmed = await promptYesNo("Proceed?", false);
      if (!confirmed) {
        runtime.log("Aborted.");
        return;
      }
    }

    // 5. Execute
    const result = await executeRemediation({
      actionIds,
      cfg,
      snapshot,
    });

    // 6. Report
    if (opts.json) {
      runtime.log(JSON.stringify(result, null, 2));
    } else {
      runtime.log(renderExecutionReportText(result));
    }
  } catch (err) {
    if (err instanceof ExecutionRefusalError) {
      runtime.error(err.message);
      runtime.exit(1);
      return;
    }
    throw err;
  }
}

export async function sessionsCleanupCommand(opts: SessionsCleanupOptions, runtime: RuntimeEnv) {
  const cfg = loadConfig();

  // -------------------------------------------------------------------------
  // Flag conflict detection (Phase 3C safety rules)
  // -------------------------------------------------------------------------
  const hasExecute = Array.isArray(opts.execute) && opts.execute.length > 0;
  const hasExecuteTier = opts.executeTier != null && opts.executeTier !== "";
  const isExecutionMode = hasExecute || hasExecuteTier;

  if (isExecutionMode && opts.dryRun) {
    runtime.error("--execute and --dry-run are contradictory. Use one or the other.");
    runtime.exit(1);
    return;
  }

  if (isExecutionMode && opts.enforce) {
    runtime.error(
      "--execute uses the remediation plan path. --enforce uses legacy maintenance. Choose one.",
    );
    runtime.exit(1);
    return;
  }

  if (hasExecute && hasExecuteTier) {
    runtime.error("--execute and --execute-tier are mutually exclusive. Use one or the other.");
    runtime.exit(1);
    return;
  }

  if (isExecutionMode && (opts.agent || opts.allAgents || opts.store)) {
    runtime.error(
      "--execute/--execute-tier operates on the default agent store only. " +
        "--agent, --all-agents, and --store are not supported in execution mode.",
    );
    runtime.exit(1);
    return;
  }

  // -------------------------------------------------------------------------
  // Execution path (Phase 3C)
  // -------------------------------------------------------------------------
  if (isExecutionMode) {
    await sessionsCleanupExecuteCommand(opts, cfg, runtime);
    return;
  }

  // -------------------------------------------------------------------------
  // Existing dry-run / enforce path
  // -------------------------------------------------------------------------
  const displayDefaults = resolveSessionDisplayDefaults(cfg);
  const mode = opts.enforce ? "enforce" : resolveMaintenanceConfig().mode;
  const targets = resolveSessionStoreTargetsOrExit({
    cfg,
    opts: {
      store: opts.store,
      agent: opts.agent,
      allAgents: opts.allAgents,
    },
    runtime,
  });
  if (!targets) {
    return;
  }

  const previewResults: Array<{
    summary: SessionCleanupSummary;
    actionRows: SessionCleanupActionRow[];
  }> = [];
  for (const target of targets) {
    const result = await previewStoreCleanup({
      target,
      mode,
      dryRun: Boolean(opts.dryRun),
      activeKey: opts.activeKey,
      fixMissing: Boolean(opts.fixMissing),
    });
    previewResults.push(result);
  }

  if (opts.dryRun) {
    // Build the remediation plan from a live health snapshot (best-effort).
    const remediationPlan = await tryBuildRemediationPlanForDryRun(cfg);

    if (opts.json) {
      if (previewResults.length === 1) {
        const payload: Record<string, unknown> = {
          ...previewResults[0]?.summary,
        };
        if (remediationPlan) {
          payload.remediationPlan = remediationPlan;
        }
        runtime.log(JSON.stringify(payload, null, 2));
        return;
      }
      const payload: Record<string, unknown> = {
        allAgents: true,
        mode,
        dryRun: true,
        stores: previewResults.map((result) => result.summary),
      };
      if (remediationPlan) {
        payload.remediationPlan = remediationPlan;
      }
      runtime.log(JSON.stringify(payload, null, 2));
      return;
    }

    for (let i = 0; i < previewResults.length; i += 1) {
      const result = previewResults[i];
      if (i > 0) {
        runtime.log("");
      }
      renderStoreDryRunPlan({
        cfg,
        summary: result.summary,
        actionRows: result.actionRows,
        displayDefaults,
        runtime,
        showAgentHeader: previewResults.length > 1,
      });
    }

    // Append remediation plan report after the existing dry-run output.
    if (remediationPlan && remediationPlan.summary.totalActions > 0) {
      runtime.log("");
      runtime.log(renderRemediationPlanText(remediationPlan));
    }
    return;
  }

  const appliedSummaries: SessionCleanupSummary[] = [];
  for (const target of targets) {
    const appliedReportRef: { current: SessionMaintenanceApplyReport | null } = {
      current: null,
    };
    const missingApplied = await updateSessionStore(
      target.storePath,
      async (store) => {
        if (!opts.fixMissing) {
          return 0;
        }
        return pruneMissingTranscriptEntries({
          store,
          storePath: target.storePath,
        });
      },
      {
        activeSessionKey: opts.activeKey,
        maintenanceOverride: {
          mode,
        },
        onMaintenanceApplied: (report) => {
          appliedReportRef.current = report;
        },
      },
    );
    const afterStore = loadSessionStore(target.storePath, { skipCache: true });
    const preview = previewResults.find((result) => result.summary.storePath === target.storePath);
    const appliedReport = appliedReportRef.current;
    const summary: SessionCleanupSummary =
      appliedReport === null
        ? {
            ...(preview?.summary ?? {
              agentId: target.agentId,
              storePath: target.storePath,
              mode,
              dryRun: false,
              beforeCount: 0,
              afterCount: 0,
              missing: 0,
              pruned: 0,
              capped: 0,
              diskBudget: null,
              wouldMutate: false,
            }),
            dryRun: false,
            applied: true,
            appliedCount: Object.keys(afterStore).length,
          }
        : {
            agentId: target.agentId,
            storePath: target.storePath,
            mode: appliedReport.mode,
            dryRun: false,
            beforeCount: appliedReport.beforeCount,
            afterCount: appliedReport.afterCount,
            missing: missingApplied,
            pruned: appliedReport.pruned,
            capped: appliedReport.capped,
            diskBudget: appliedReport.diskBudget,
            wouldMutate:
              missingApplied > 0 ||
              appliedReport.pruned > 0 ||
              appliedReport.capped > 0 ||
              Boolean(
                (appliedReport.diskBudget?.removedEntries ?? 0) > 0 ||
                (appliedReport.diskBudget?.removedFiles ?? 0) > 0,
              ),
            applied: true,
            appliedCount: Object.keys(afterStore).length,
          };
    appliedSummaries.push(summary);
  }

  if (opts.json) {
    if (appliedSummaries.length === 1) {
      runtime.log(JSON.stringify(appliedSummaries[0] ?? {}, null, 2));
      return;
    }
    runtime.log(
      JSON.stringify(
        {
          allAgents: true,
          mode,
          dryRun: false,
          stores: appliedSummaries,
        },
        null,
        2,
      ),
    );
    return;
  }

  for (let i = 0; i < appliedSummaries.length; i += 1) {
    const summary = appliedSummaries[i];
    if (i > 0) {
      runtime.log("");
    }
    if (appliedSummaries.length > 1) {
      runtime.log(`Agent: ${summary.agentId}`);
    }
    runtime.log(`Session store: ${summary.storePath}`);
    runtime.log(`Applied maintenance. Current entries: ${summary.appliedCount ?? 0}`);
  }
}
