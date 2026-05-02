import fs from "node:fs";
import { getRuntimeConfig } from "../config/config.js";
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
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway, isGatewayTransportError } from "../gateway/call.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { isRich, theme } from "../terminal/theme.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  resolveSessionStoreTargets,
  resolveSessionStoreTargetsOrExit,
  type SessionStoreTarget,
} from "./session-store-targets.js";
import {
  resolveSessionDisplayDefaults,
  resolveSessionDisplayModel,
} from "./sessions-display-model.js";
import {
  formatSessionAgeCell,
  formatSessionFlagsCell,
  formatSessionKeyCell,
  formatSessionModelCell,
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

export type SessionsCleanupResult =
  | SessionCleanupSummary
  | {
      allAgents: true;
      mode: "warn" | "enforce";
      dryRun: boolean;
      stores: SessionCleanupSummary[];
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
  return toSessionDisplayRows(params.beforeStore).map((row) =>
    Object.assign({}, row, {
      action: resolveSessionCleanupAction({
        key: row.key,
        missingKeys: params.missingKeys,
        staleKeys: params.staleKeys,
        cappedKeys: params.cappedKeys,
        budgetEvictedKeys: params.budgetEvictedKeys,
      }),
    }),
  );
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
    (diskBudget?.removedEntries ?? 0) > 0 ||
    (diskBudget?.removedFiles ?? 0) > 0;

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

function serializeSessionCleanupResult(params: {
  mode: "warn" | "enforce";
  dryRun: boolean;
  summaries: SessionCleanupSummary[];
}): SessionsCleanupResult {
  if (params.summaries.length === 1) {
    return params.summaries[0] ?? ({} as SessionCleanupSummary);
  }
  return {
    allAgents: true,
    mode: params.mode,
    dryRun: params.dryRun,
    stores: params.summaries,
  };
}

function renderStoreDryRunPlan(params: {
  cfg: OpenClawConfig;
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
  params.runtime.log(`Would prune missing transcripts: ${params.summary.missing}`);
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
    const model = resolveSessionDisplayModel(params.cfg, actionRow);
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

function renderAppliedSummaries(params: {
  summaries: SessionCleanupSummary[];
  runtime: RuntimeEnv;
}) {
  for (let i = 0; i < params.summaries.length; i += 1) {
    const summary = params.summaries[i];
    if (!summary) {
      continue;
    }
    if (i > 0) {
      params.runtime.log("");
    }
    if (params.summaries.length > 1) {
      params.runtime.log(`Agent: ${summary.agentId}`);
    }
    params.runtime.log(`Session store: ${summary.storePath}`);
    params.runtime.log(`Applied maintenance. Current entries: ${summary.appliedCount ?? 0}`);
  }
}

export async function runSessionsCleanup(params: {
  cfg: OpenClawConfig;
  opts: SessionsCleanupOptions;
  targets?: SessionStoreTarget[];
}): Promise<{
  mode: "warn" | "enforce";
  previewResults: Array<{
    summary: SessionCleanupSummary;
    actionRows: SessionCleanupActionRow[];
  }>;
  appliedSummaries: SessionCleanupSummary[];
}> {
  const { cfg, opts } = params;
  const mode = opts.enforce ? "enforce" : resolveMaintenanceConfig().mode;
  const targets =
    params.targets ??
    resolveSessionStoreTargets(cfg, {
      store: opts.store,
      agent: opts.agent,
      allAgents: opts.allAgents,
    });

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

  const appliedSummaries: SessionCleanupSummary[] = [];
  if (!opts.dryRun) {
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
      const preview = previewResults.find(
        (result) => result.summary.storePath === target.storePath,
      );
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
                (appliedReport.diskBudget?.removedEntries ?? 0) > 0 ||
                (appliedReport.diskBudget?.removedFiles ?? 0) > 0,
              applied: true,
              appliedCount: Object.keys(afterStore).length,
            };
      appliedSummaries.push(summary);
    }
  }

  return { mode, previewResults, appliedSummaries };
}

async function maybeRunGatewayCleanup(
  opts: SessionsCleanupOptions,
): Promise<SessionsCleanupResult | null> {
  if (opts.store || opts.dryRun) {
    return null;
  }
  try {
    return await callGateway<SessionsCleanupResult>({
      method: "sessions.cleanup",
      params: {
        agent: opts.agent,
        allAgents: opts.allAgents,
        enforce: opts.enforce,
        activeKey: opts.activeKey,
        fixMissing: opts.fixMissing,
      },
      mode: GATEWAY_CLIENT_MODES.CLI,
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      requiredMethods: ["sessions.cleanup"],
    });
  } catch (error) {
    if (isGatewayTransportError(error)) {
      return null;
    }
    throw error;
  }
}

export async function sessionsCleanupCommand(opts: SessionsCleanupOptions, runtime: RuntimeEnv) {
  const gatewayResult = await maybeRunGatewayCleanup(opts);
  if (gatewayResult) {
    if (opts.json) {
      writeRuntimeJson(runtime, gatewayResult);
      return;
    }
    renderAppliedSummaries({
      summaries: "stores" in gatewayResult ? gatewayResult.stores : [gatewayResult],
      runtime,
    });
    return;
  }

  const cfg = getRuntimeConfig();
  const displayDefaults = resolveSessionDisplayDefaults(cfg);
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
  const { mode, previewResults, appliedSummaries } = await runSessionsCleanup({
    cfg,
    opts,
    targets,
  });

  if (opts.dryRun) {
    if (opts.json) {
      writeRuntimeJson(
        runtime,
        serializeSessionCleanupResult({
          mode,
          dryRun: true,
          summaries: previewResults.map((result) => result.summary),
        }),
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

  if (opts.json) {
    writeRuntimeJson(
      runtime,
      serializeSessionCleanupResult({
        mode,
        dryRun: false,
        summaries: appliedSummaries,
      }),
    );
    return;
  }

  renderAppliedSummaries({ summaries: appliedSummaries, runtime });
}
