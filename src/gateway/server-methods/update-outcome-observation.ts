import { isPublicUpdateFailureCode } from "../../infra/update-failure-public-codes.js";
import { refreshUpdateRunReportArtifact } from "../../infra/update-failure-report-artifact.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { classifyUpdateOutcome } from "../../shared/update-outcome.js";
import { formatControlPlaneActor, type ControlPlaneActor } from "../control-plane-audit.js";
import type { GatewayRequestContext } from "./types.js";

export function recordGatewayUpdateOutcome(
  result: UpdateRunResult,
  actor: ControlPlaneActor,
  logGateway: GatewayRequestContext["logGateway"],
): void {
  const message = `update.run completed ${formatControlPlaneActor(actor)} restartReason=update.run status=${result.status}`;
  if (classifyUpdateOutcome(result) !== "failed") {
    logGateway?.info(message);
    return;
  }
  const publicReason =
    result.reason && isPublicUpdateFailureCode(result.reason) ? result.reason : "unavailable";
  // Only public identifiers cross this boundary, never command tails or exception prose.
  const failure = result.steps.findLast(
    (step) => step.failureFacts?.length || (step.exitCode !== null && step.exitCode !== 0),
  );
  const fact = failure?.failureFacts?.[0];
  const errorName =
    fact?.errorName && isPublicUpdateFailureCode(fact.errorName) ? fact.errorName : "Error";
  const code = fact?.code && isPublicUpdateFailureCode(fact.code) ? ` code=${fact.code}` : "";
  const summary = failure
    ? `${errorName}${code}${failure.exitCode !== null ? ` exitCode=${failure.exitCode}` : ""}`
    : "Update request refused";
  logGateway?.warn(`${message} reason=${publicReason} error=${JSON.stringify(summary)}`);
}

export async function saveFailedUpdateRunReport(
  terminalRun: UpdateRunRecord,
  logGateway: GatewayRequestContext["logGateway"],
): Promise<void> {
  if (terminalRun.status !== "failed") {
    return;
  }
  try {
    await refreshUpdateRunReportArtifact(terminalRun);
  } catch {
    logGateway?.warn("update.run report artifact could not be saved");
  }
}
