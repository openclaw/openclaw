import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import type { RestartSentinelPayload } from "../infra/restart-sentinel.js";
import { getUpdateRun, getUpdateRunAsync } from "../infra/update-run-ledger.js";
import { isAcknowledgedAbandonedUpdateRun } from "../infra/update-run-record.js";
import {
  renderUpdateRunReport,
  updateRunReportInputFromSentinel,
} from "../infra/update-run-report.js";
import { readUpdateRunStatus } from "../infra/update-run-status.js";

type Formatter = (value: string) => string;
type StatusReportOptions = {
  ok?: Formatter;
  warn?: Formatter;
  muted?: Formatter;
  localGatewayHealthy?: boolean;
};

function renderStatusReport(
  run: Parameters<typeof renderUpdateRunReport>[0],
  localGatewayHealthy = false,
) {
  const report = renderUpdateRunReport(run);
  const reconciled = isAcknowledgedAbandonedUpdateRun(run);
  const historicalFailure = run.status === "failed" && !reconciled && localGatewayHealthy;
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
    historicalFailure,
    headline: historicalFailure
      ? `Last update run failed (${sanitizeTerminalText(run.reason?.trim() || "unknown reason").slice(0, 240)}) — Gateway is currently healthy; run \`openclaw update\` to reconcile.`
      : message
        ? `${report.headline} ${message}`
        : report.headline,
  };
}

function readReport(payload: RestartSentinelPayload, localGatewayHealthy = false) {
  const run = payload.stats?.runId ? getUpdateRun(payload.stats.runId) : undefined;
  return renderStatusReport(run ?? updateRunReportInputFromSentinel(payload), localGatewayHealthy);
}

export function formatUpdateRestartStatusValue(
  payload: RestartSentinelPayload | null | undefined,
  opts: StatusReportOptions = {},
): string | null {
  if (!payload || payload.kind !== "update") {
    return null;
  }
  return formatUpdateRestartReport(payload, readReport(payload, opts.localGatewayHealthy), opts);
}

function formatUpdateRestartReport(
  payload: RestartSentinelPayload,
  { headline, reconciled, historicalFailure }: ReturnType<typeof renderStatusReport>,
  opts: StatusReportOptions,
): string {
  const format =
    reconciled || historicalFailure
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
  const rows = run
    ? [{ Item: "Update run", Value: renderStatusReport(run, opts.localGatewayHealthy).headline }]
    : [];
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
      renderStatusReport(
        restartRun ?? updateRunReportInputFromSentinel(payload),
        opts.localGatewayHealthy,
      ),
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
