import type { RestartSentinelPayload } from "../infra/restart-sentinel.js";
import { getUpdateRun, getUpdateRunAsync } from "../infra/update-run-ledger.js";
import { isAcknowledgedAbandonedUpdateRun } from "../infra/update-run-record.js";
import {
  renderUpdateRunReport,
  updateRunReportInputFromSentinel,
} from "../infra/update-run-report.js";
import { readUpdateRunStatus } from "../infra/update-run-status.js";

type Formatter = (value: string) => string;

function renderStatusReport(run: Parameters<typeof renderUpdateRunReport>[0]) {
  const report = renderUpdateRunReport(run);
  const reconciled = isAcknowledgedAbandonedUpdateRun(run);
  const message =
    run.status === "failed" && !reconciled
      ? run.steps
          .filter((step) => step.status === "failed")
          .flatMap((step) => step.failureFacts ?? [])
          .find((fact) => fact.message)?.message
      : undefined;
  return {
    ...report,
    reconciled,
    headline: message ? `${report.headline} ${message}` : report.headline,
  };
}

function readReport(payload: RestartSentinelPayload) {
  const run = payload.stats?.runId ? getUpdateRun(payload.stats.runId) : undefined;
  return renderStatusReport(run ?? updateRunReportInputFromSentinel(payload));
}

export function formatUpdateRestartStatusValue(
  payload: RestartSentinelPayload | null | undefined,
  opts: { ok?: Formatter; warn?: Formatter; muted?: Formatter } = {},
): string | null {
  if (!payload || payload.kind !== "update") {
    return null;
  }
  return formatUpdateRestartReport(payload, readReport(payload), opts);
}

function formatUpdateRestartReport(
  payload: RestartSentinelPayload,
  { headline, reconciled }: ReturnType<typeof renderStatusReport>,
  opts: { ok?: Formatter; warn?: Formatter; muted?: Formatter },
): string {
  const format = reconciled
    ? opts.muted
    : payload.status === "error"
      ? opts.warn
      : payload.status === "ok"
        ? opts.ok
        : opts.muted;
  return format ? format(headline) : headline;
}

/** Keep recorded progress and history separate from the current installation's update check. */
export async function buildStatusUpdateRows(
  payload: RestartSentinelPayload | null | undefined,
  opts: Parameters<typeof formatUpdateRestartStatusValue>[1] = {},
) {
  const history = await readUpdateRunStatus();
  if ("runStatusError" in history) {
    return [
      { Item: "Update run", Value: `Update run status unavailable: ${history.runStatusError}` },
    ];
  }
  const run = history.activeRun ?? history.lastRun;
  const rows = run ? [{ Item: "Update run", Value: renderStatusReport(run).headline }] : [];
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
  if (payload?.kind === "update" && (!run || payload.stats?.runId !== run.runId)) {
    const restartRun = payload.stats?.runId
      ? await getUpdateRunAsync(payload.stats.runId)
      : undefined;
    const restart = formatUpdateRestartReport(
      payload,
      renderStatusReport(restartRun ?? updateRunReportInputFromSentinel(payload)),
      opts,
    );
    if (restart) {
      rows.push({ Item: "Update restart", Value: restart });
    }
  }
  return rows;
}

export function formatUpdateRestartActionLines(
  payload: RestartSentinelPayload | null | undefined,
): string[] {
  return payload?.kind === "update" ? readReport(payload).lines : [];
}
