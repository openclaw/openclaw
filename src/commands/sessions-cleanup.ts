import { loadConfig } from "../config/config.js";
import {
  capEntryCount,
  enforceSessionDiskBudget,
  loadSessionStore,
  pruneStaleEntries,
  resolveMaintenanceConfig,
  updateSessionStore,
  type SessionEntry,
  type SessionMaintenanceApplyReport,
} from "../config/sessions.js";
import type { RuntimeEnv } from "../runtime.js";
import { isRich, theme } from "../terminal/theme.js";
import { resolveSessionStoreTargets, type SessionStoreTarget } from "./session-store-targets.js";
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
};

type SessionCleanupAction = "keep" | "prune-stale" | "cap-overflow" | "evict-budget";

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
  pruned: number;
  capped: number;
  diskBudget: Awaited<ReturnType<typeof enforceSessionDiskBudget>>;
  wouldMutate: boolean;
  applied?: true;
  appliedCount?: number;
};

function resolveSessionCleanupAction(params: {
  key: string;
  staleKeys: Set<string>;
  cappedKeys: Set<string>;
  budgetEvictedKeys: Set<string>;
}): SessionCleanupAction {
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
  staleKeys: Set<string>;
  cappedKeys: Set<string>;
  budgetEvictedKeys: Set<string>;
}): SessionCleanupActionRow[] {
  return toSessionDisplayRows(params.beforeStore).map((row) => ({
    ...row,
    action: resolveSessionCleanupAction({
      key: row.key,
      staleKeys: params.staleKeys,
      cappedKeys: params.cappedKeys,
      budgetEvictedKeys: params.budgetEvictedKeys,
    }),
  }));
}

async function previewStoreCleanup(params: {
  target: SessionStoreTarget;
  mode: "warn" | "enforce";
  dryRun: boolean;
  activeKey?: string;
}) {
  const maintenance = resolveMaintenanceConfig();
  const beforeStore = loadSessionStore(params.target.storePath, { skipCache: true });
  const previewStore = structuredClone(beforeStore);
  const staleKeys = new Set<string>();
  const cappedKeys = new Set<string>();
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
  params.runtime.log(`Maintenance mode: ${params.summary.mode}`);
  params.runtime.log(
    `Entries: ${params.summary.beforeCount} -> ${params.summary.afterCount} (remove ${params.summary.beforeCount - params.summary.afterCount})`,
  );
  params.runtime.log(`Would prune stale: ${params.summary.pruned}`);
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

export async function sessionsCleanupCommand(opts: SessionsCleanupOptions, runtime: RuntimeEnv) {
  const cfg = loadConfig();
  const displayDefaults = resolveSessionDisplayDefaults(cfg);
  const mode = opts.enforce ? "enforce" : resolveMaintenanceConfig().mode;
  let targets: SessionStoreTarget[];
  try {
    targets = resolveSessionStoreTargets(cfg, {
      store: opts.store,
      agent: opts.agent,
      allAgents: opts.allAgents,
    });
  } catch (error) {
    runtime.error(error instanceof Error ? error.message : String(error));
    runtime.exit(1);
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
    });
    previewResults.push(result);
  }

  if (opts.dryRun) {
    if (opts.json) {
      if (previewResults.length === 1) {
        runtime.log(JSON.stringify(previewResults[0]?.summary ?? {}, null, 2));
        return;
      }
      runtime.log(
        JSON.stringify(
          {
            allAgents: true,
            mode,
            dryRun: true,
            stores: previewResults.map((result) => result.summary),
          },
          null,
          2,
        ),
      );
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
    return;
  }

  const appliedSummaries: SessionCleanupSummary[] = [];
  for (const target of targets) {
    const appliedReportRef: { current: SessionMaintenanceApplyReport | null } = {
      current: null,
    };
    await updateSessionStore(
      target.storePath,
      async () => {
        // Maintenance runs in saveSessionStoreUnlocked(); no direct store mutation needed here.
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
            pruned: appliedReport.pruned,
            capped: appliedReport.capped,
            diskBudget: appliedReport.diskBudget,
            wouldMutate:
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
