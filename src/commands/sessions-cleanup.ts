import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { visibleWidth } from "../../packages/terminal-core/src/ansi.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { getTerminalTableWidth, renderTable } from "../../packages/terminal-core/src/table.js";
import { colorize, isRich, theme } from "../../packages/terminal-core/src/theme.js";
import { captureRuntimeConfigAsyncReader } from "../config/config.js";
import {
  resolveSessionCleanupAction,
  isSessionsCleanupPartialResult,
  runSessionsCleanup,
  serializeSessionCleanupResult,
  type SessionCleanupSummary,
  type SessionsCleanupOptions,
  type SessionsCleanupResult,
} from "../config/sessions.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayMutationFallback } from "../gateway/call-mutation-fallback.js";
import {
  buildGatewayConnectionDetails,
  callGateway,
  isImplicitLocalGatewayTarget,
} from "../gateway/call.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { resolveCommandSessionStoreTargets } from "./session-store-targets.js";
import { resolveSessionDisplayModelRef } from "./sessions-display-model.js";
import {
  formatSessionAgeCell,
  formatSessionFlagsCell,
  formatSessionKeyCell,
  formatSessionModelCell,
  toSessionDisplayRows,
} from "./sessions-table.js";

type SessionCleanupActionRow = ReturnType<typeof buildActionRows>[number];

type SessionCleanupLabelSummary = {
  label: string;
  kept: number;
  pruned: number;
};

function formatCleanupActionCell(
  action: ReturnType<typeof resolveSessionCleanupAction>,
  rich: boolean,
): string {
  if (!rich) {
    return action;
  }
  if (action === "keep") {
    return theme.muted(action);
  }
  if (
    action === "archive-dashboard" ||
    action === "archive-cap" ||
    action === "archive-age" ||
    action === "prune-model-run" ||
    action === "prune-stale" ||
    action === "retire-dm-scope"
  ) {
    return theme.warn(action);
  }
  if (action === "cap-overflow") {
    return theme.accentBright(action);
  }
  return theme.error(action);
}

function buildActionRows(
  params: Awaited<ReturnType<typeof runSessionsCleanup>>["previewResults"][number],
) {
  // Recompute row actions from the preview sets so dry-run output uses the same
  // action labels as the cleanup engine without mutating the preview store.
  return toSessionDisplayRows(params.beforeStore).map((row) =>
    Object.assign({}, row, {
      label: params.beforeStore[row.key]?.label,
      action: resolveSessionCleanupAction({ ...params, key: row.key }),
    }),
  );
}

function buildLabelSummaries(actionRows: SessionCleanupActionRow[]): SessionCleanupLabelSummary[] {
  const summaryByLabel = new Map<string, SessionCleanupLabelSummary>();
  for (const actionRow of actionRows) {
    const rawLabel = typeof actionRow.label === "string" ? actionRow.label.trim() : "";
    const label = sanitizeTerminalText(rawLabel) || "(unlabeled)";
    let summary = summaryByLabel.get(label);
    if (!summary) {
      summary = { label, kept: 0, pruned: 0 };
      summaryByLabel.set(label, summary);
    }
    if (
      actionRow.action === "keep" ||
      actionRow.action === "archive-dashboard" ||
      actionRow.action === "archive-cap" ||
      actionRow.action === "archive-age"
    ) {
      summary.kept += 1;
    } else {
      summary.pruned += 1;
    }
  }
  return [...summaryByLabel.values()].toSorted((a, b) => a.label.localeCompare(b.label));
}

function toDisplayedCleanupSummary(summary: SessionCleanupSummary): SessionCleanupSummary {
  return {
    ...summary,
    storePath: resolveSqliteTargetFromSessionStorePath(summary.storePath, {
      agentId: summary.agentId,
    }).path,
  };
}

function renderAppliedResult(
  result: SessionsCleanupResult,
  runtime: RuntimeEnv,
  json: boolean | undefined,
) {
  const partialError = "partialError" in result ? result.partialError : undefined;
  if (json) {
    writeRuntimeJson(runtime, result);
  } else {
    const summaries = "stores" in result ? result.stores : [result];
    renderAppliedSummaries(summaries, runtime);
    if (partialError) {
      runtime.error(`[error] ${partialError.message}`);
    }
  }
  if (partialError) {
    process.exitCode = 1;
  }
}

function renderAppliedSummaries(summaries: SessionCleanupSummary[], runtime: RuntimeEnv) {
  for (const [i, summary] of summaries.entries()) {
    if (i > 0) {
      runtime.log("");
    }
    if (summaries.length > 1) {
      runtime.log(`Agent: ${summary.agentId}`);
    }
    runtime.log(`Session store: ${summary.storePath}`);
    runtime.log(`Applied maintenance. Current entries: ${summary.appliedCount ?? 0}`);
    if (summary.unreferencedArtifacts?.removedFiles) {
      runtime.log(`Pruned unreferenced artifacts: ${summary.unreferencedArtifacts.removedFiles}`);
    }
  }
}

async function maybeRunGatewayCleanup(
  opts: SessionsCleanupOptions,
  cfg: OpenClawConfig,
): Promise<{ delegated: true; result: SessionsCleanupResult } | { delegated: false }> {
  if (opts.store !== undefined || opts.dryRun) {
    // Explicit store paths and dry-runs stay local; sessions.cleanup takes no store param.
    // A blank --store is explicit too: delegating it would clean the default store.
    return { delegated: false };
  }
  const { url } = buildGatewayConnectionDetails({ config: cfg });
  const localTarget = await isImplicitLocalGatewayTarget({ config: cfg });
  try {
    const result = await callGateway<SessionsCleanupResult>({
      config: cfg,
      expectUrl: url,
      method: "sessions.cleanup",
      // Maintenance can outlive passive reads; keep the connection's startup deadline.
      timeoutMs: null,
      params: {
        agent: opts.agent,
        allAgents: opts.allAgents,
        enforce: opts.enforce,
        activeKey: opts.activeKey,
        fixMissing: opts.fixMissing,
        fixDmScope: opts.fixDmScope,
      },
      mode: GATEWAY_CLIENT_MODES.CLI,
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      requiredMethods: ["sessions.cleanup"],
    });
    return { delegated: true, result };
  } catch (error) {
    if (resolveGatewayMutationFallback({ error, localTarget }) === "unreachable") {
      return { delegated: false };
    }
    if (isRecord(error) && isSessionsCleanupPartialResult(error.details)) {
      return { delegated: true, result: error.details };
    }
    throw error;
  }
}

/** Runs session cleanup, optionally using the live gateway for active stores. */
export async function sessionsCleanupCommand(opts: SessionsCleanupOptions, runtime: RuntimeEnv) {
  const cfg = await captureRuntimeConfigAsyncReader()();
  const gatewayCleanup = await maybeRunGatewayCleanup(opts, cfg);
  if (gatewayCleanup.delegated) {
    // The Gateway owns this path. Preserve its syntax because resolving a remote
    // Windows path on a POSIX client (or vice versa) would fabricate a local path.
    renderAppliedResult(gatewayCleanup.result, runtime, opts.json);
    return;
  }

  const targets = resolveCommandSessionStoreTargets({ cfg, opts });
  const cleanupParams = { cfg, opts, targets };
  let cleanupResult;
  if (opts.dryRun) {
    cleanupResult = await runSessionsCleanup(cleanupParams);
  } else {
    const { runLocalSessionsCleanup } = await import("./sessions-cleanup.runtime.js");
    cleanupResult = await runLocalSessionsCleanup(cleanupParams, runtime);
  }
  const { mode, previewResults, appliedSummaries, failure } = cleanupResult;

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

    for (const [i, result] of previewResults.entries()) {
      if (i > 0) {
        runtime.log("");
      }
      const storeSummary = result.summary;
      const actionRows = buildActionRows(result);
      const showAgentHeader = previewResults.length > 1;
      const rich = isRich();
      const displaySummary = toDisplayedCleanupSummary(storeSummary);
      if (showAgentHeader) {
        runtime.log(`Agent: ${storeSummary.agentId}`);
      }
      runtime.log(`Session store: ${displaySummary.storePath}`);
      runtime.log(`Maintenance mode: ${storeSummary.mode}`);
      runtime.log(
        `Entries: ${storeSummary.beforeCount} -> ${storeSummary.afterCount} (remove ${storeSummary.beforeCount - storeSummary.afterCount})`,
      );
      runtime.log(`Would prune missing transcripts: ${storeSummary.missing}`);
      runtime.log(`Would retire stale direct DM sessions: ${storeSummary.dmScopeRetired}`);
      runtime.log(`Would prune stale model-run checks: ${storeSummary.modelRunPruned}`);
      runtime.log(`Would archive inactive sessions: ${storeSummary.archived ?? 0}`);
      runtime.log(`Would archive cap overflow: ${storeSummary.capArchived ?? 0}`);
      runtime.log(`Would prune stale: ${storeSummary.pruned}`);
      runtime.log(`Would cap overflow: ${storeSummary.capped}`);
      if (storeSummary.unreferencedArtifacts?.scannedFiles) {
        runtime.log(
          `Would prune unreferenced artifacts: ${storeSummary.unreferencedArtifacts.removedFiles}`,
        );
      }
      if (storeSummary.diskBudget) {
        runtime.log(
          `Would enforce disk budget: ${storeSummary.diskBudget.totalBytesBefore} -> ${storeSummary.diskBudget.totalBytesAfter} bytes (files ${storeSummary.diskBudget.removedFiles}, entries ${storeSummary.diskBudget.removedEntries})`,
        );
      }
      if (actionRows.length === 0) {
        continue;
      }
      runtime.log("");
      runtime.log("Planned session actions:");
      runtime.log(
        renderTable({
          width: getTerminalTableWidth(),
          columns: [
            { key: "action", header: "Action" },
            { key: "key", header: "Key" },
            { key: "age", header: "Age" },
            { key: "model", header: "Model" },
            { key: "flags", header: "Flags", flex: true },
          ].map((column) =>
            Object.assign(column, { header: colorize(rich, theme.heading, column.header) }),
          ),
          rows: actionRows.map((row) => ({
            action: formatCleanupActionCell(row.action, rich),
            key: formatSessionKeyCell(row.key, rich),
            age: formatSessionAgeCell(row.updatedAt, rich),
            model: formatSessionModelCell(resolveSessionDisplayModelRef(cfg, row).model, rich),
            flags: formatSessionFlagsCell(row, rich),
          })),
        }).trimEnd(),
      );
      const summaries = buildLabelSummaries(actionRows);
      if (summaries.length === 0) {
        continue;
      }
      const labelPad = summaries.reduce(
        (max, summary) => Math.max(max, visibleWidth(summary.label)),
        0,
      );
      const totalKept = summaries.reduce((total, summary) => total + summary.kept, 0);
      const totalPruned = summaries.reduce((total, summary) => total + summary.pruned, 0);
      runtime.log("");
      runtime.log("Summary by Label:");
      for (const summary of summaries) {
        const remaining = labelPad - visibleWidth(summary.label);
        const paddedLabel =
          remaining > 0 ? `${summary.label}${" ".repeat(remaining)}` : summary.label;
        runtime.log(`${paddedLabel}  ${summary.kept} kept, ${summary.pruned} pruned`);
      }
      runtime.log(`Total: ${totalKept} kept, ${totalPruned} pruned`);
    }
    return;
  }

  renderAppliedResult(
    serializeSessionCleanupResult({ mode, dryRun: false, summaries: appliedSummaries, failure }),
    runtime,
    opts.json,
  );
}
