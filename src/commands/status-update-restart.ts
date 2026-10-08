import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import type { GatewayProbeServerSummary } from "../gateway/probe.js";
import type { RestartSentinelPayload } from "../infra/restart-sentinel.js";
import { getUpdateRun, getUpdateRunAsync } from "../infra/update-run-ledger.js";
import { isAcknowledgedAbandonedUpdateRun } from "../infra/update-run-record.js";
import {
  renderUpdateRunReport,
  resolveUpdateRunIdentity,
  updateRunReportInputFromSentinel,
} from "../infra/update-run-report.js";
import { readUpdateRunStatus } from "../infra/update-run-status.js";

type Formatter = (value: string) => string;
type StatusReportOptions = {
  ok?: Formatter;
  warn?: Formatter;
  muted?: Formatter;
  localGatewayHealthy?: boolean;
  gatewayServer?: Pick<GatewayProbeServerSummary, "version" | "buildId">;
};

function renderStatusReport(
  run: Parameters<typeof renderUpdateRunReport>[0],
  opts: StatusReportOptions = {},
) {
  const report = renderUpdateRunReport(run);
  const reconciled = isAcknowledgedAbandonedUpdateRun(run);
  const rollbackAttempted =
    run.verification.recovery?.packageRollbackVerified === true ||
    run.verification.rollbackOutcome?.status === "succeeded" ||
    run.verification.rollbackOutcome?.status === "failed";
  // Rollback can rewrite `after` and verify the previous package. Those facts
  // cannot establish the candidate build, even when both versions are equal.
  // A failed verification can record the old serving process; only a matching
  // verification is evidence of the intended target when candidate identity is absent.
  const verifiedVersion =
    !rollbackAttempted && run.verification.versionMatch === true
      ? normalizeOptionalString(run.verification.runningVersion)
      : undefined;
  const beforeVersion = normalizeOptionalString(run.before.version);
  const afterVersion = normalizeOptionalString(run.after.version);
  const explicitTargetVersion =
    normalizeOptionalString(run.target?.version) ??
    normalizeOptionalString(run.origin.admission?.candidateVersion);
  const afterIsDistinctTarget = Boolean(
    explicitTargetVersion &&
    beforeVersion &&
    explicitTargetVersion !== beforeVersion &&
    afterVersion === explicitTargetVersion,
  );
  const afterIdentityAvailable =
    (!rollbackAttempted || afterIsDistinctTarget) &&
    resolveUpdateRunIdentity(run.verification, run.after).kind !== "unavailable";
  const targetVersion =
    explicitTargetVersion ?? (afterIdentityAvailable ? afterVersion : undefined) ?? verifiedVersion;
  const targetBuild =
    (afterIdentityAvailable && (!afterVersion || afterVersion === targetVersion)
      ? normalizeOptionalString(run.after.buildId)
      : undefined) ??
    (verifiedVersion === targetVersion && verifiedVersion
      ? normalizeOptionalString(run.verification.runningBuildId)
      : undefined);
  const servingVersion = normalizeOptionalString(opts.gatewayServer?.version);
  const servingBuild = normalizeOptionalString(opts.gatewayServer?.buildId);
  const buildMismatch = Boolean(targetBuild && servingBuild && targetBuild !== servingBuild);
  const previousVersion = beforeVersion ?? afterVersion;
  const targetIdentityUnavailable =
    (!afterIdentityAvailable && targetVersion === afterVersion) ||
    (rollbackAttempted && (!previousVersion || targetVersion === previousVersion));
  const observedFailure = run.status === "failed" && !reconciled && opts.localGatewayHealthy;
  const historicalFailure = Boolean(
    observedFailure &&
    targetVersion &&
    servingVersion === targetVersion &&
    !buildMismatch &&
    !targetIdentityUnavailable,
  );
  const message =
    run.status === "failed" && !reconciled
      ? run.steps
          .filter((step) => step.status === "failed")
          .flatMap((step) => step.failureFacts ?? [])
          .find((fact) => fact.message)?.message
      : undefined;
  let headline = message ? `${report.headline} ${message}` : report.headline;
  const servingLabel = sanitizeTerminalText(servingVersion ?? "an unknown version").slice(0, 240);
  const targetLabel = sanitizeTerminalText(targetVersion ?? "an unknown target").slice(0, 240);
  if (historicalFailure) {
    headline = `Last update run failed (${sanitizeTerminalText(run.reason?.trim() || "unknown reason").slice(0, 240)}) — Gateway is serving ${servingLabel}; run \`openclaw update\` to clear the record.`;
  } else if (observedFailure) {
    const current =
      (buildMismatch || targetIdentityUnavailable) && servingBuild
        ? `${servingLabel} (build ${sanitizeTerminalText(servingBuild).slice(0, 240)})`
        : servingLabel;
    const target =
      buildMismatch && targetBuild
        ? `${targetLabel} (build ${sanitizeTerminalText(targetBuild).slice(0, 240)})`
        : targetLabel;
    const detail = !targetVersion
      ? `Gateway is serving ${current}; the update target is unknown`
      : !servingVersion
        ? `Gateway serving version is unknown; the update to ${target} is unverified`
        : targetIdentityUnavailable
          ? `Gateway is still serving ${current}; the intended build for ${target} is unverified`
          : `Gateway is still serving ${current}; the update to ${target} did not complete`;
    headline += `\n${detail} — run \`openclaw update\`.`;
  }
  return {
    ...report,
    reconciled,
    historicalFailure,
    headline,
  };
}

function readReport(payload: RestartSentinelPayload, opts: StatusReportOptions = {}) {
  const run = payload.stats?.runId ? getUpdateRun(payload.stats.runId) : undefined;
  return renderStatusReport(run ?? updateRunReportInputFromSentinel(payload), opts);
}

export function formatUpdateRestartStatusValue(
  payload: RestartSentinelPayload | null | undefined,
  opts: StatusReportOptions = {},
): string | null {
  if (!payload || payload.kind !== "update") {
    return null;
  }
  return formatUpdateRestartReport(payload, readReport(payload, opts), opts);
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
  const rows = run ? [{ Item: "Update run", Value: renderStatusReport(run, opts).headline }] : [];
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
      renderStatusReport(restartRun ?? updateRunReportInputFromSentinel(payload), opts),
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
