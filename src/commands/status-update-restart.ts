import type { RestartSentinelPayload } from "../infra/restart-sentinel.js";
import { getUpdateRun } from "../infra/update-run-ledger.js";
import {
  renderUpdateRunReport,
  updateRunReportInputFromSentinel,
} from "../infra/update-run-report.js";
import { readUpdateRunStatus } from "../infra/update-run-status.js";

type Formatter = (value: string) => string;

function readReport(payload: RestartSentinelPayload) {
  const run = payload.stats?.runId ? getUpdateRun(payload.stats.runId) : undefined;
  return renderUpdateRunReport(run ?? updateRunReportInputFromSentinel(payload));
}

export function formatUpdateRestartStatusValue(
  payload: RestartSentinelPayload | null | undefined,
  opts: { ok?: Formatter; warn?: Formatter; muted?: Formatter } = {},
): string | null {
  if (!payload || payload.kind !== "update") {
    return null;
  }
  const headline = readReport(payload).headline;
  const format =
    payload.status === "error" ? opts.warn : payload.status === "ok" ? opts.ok : opts.muted;
  return format ? format(headline) : headline;
}

/** Keep recorded progress and history separate from the current installation's update check. */
export function buildStatusUpdateRows(
  payload: RestartSentinelPayload | null | undefined,
  opts: Parameters<typeof formatUpdateRestartStatusValue>[1] = {},
) {
  const history = readUpdateRunStatus();
  if ("runStatusError" in history) {
    return [
      { Item: "Update run", Value: `Update run status unavailable: ${history.runStatusError}` },
    ];
  }
  const run = history.activeRun ?? history.lastRun;
  const rows = run ? [{ Item: "Update run", Value: renderUpdateRunReport(run).headline }] : [];
  if (history.runReconciliationError) {
    rows.push({
      Item: "Update reconciliation",
      Value: `Update run reconciliation failed: ${history.runReconciliationError}`,
    });
  }
  for (const advisory of history.advisories ?? []) {
    rows.push({ Item: "Update advisory", Value: advisory.message });
  }
  // Legacy sentinels lack run IDs; matching prose cannot establish the same occurrence.
  const restart =
    !run || payload?.stats?.runId !== run.runId
      ? formatUpdateRestartStatusValue(payload, opts)
      : null;
  return restart ? [...rows, { Item: "Update restart", Value: restart }] : rows;
}

export function formatUpdateRestartActionLines(
  payload: RestartSentinelPayload | null | undefined,
): string[] {
  return payload?.kind === "update" ? readReport(payload).lines : [];
}
