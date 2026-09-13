// Only the original foreground parent consumes this result after native cleanup and release.
import type { InstallationTarget } from "../infra/installation-target-context.js";
import type { continueTriageInFreshProcess } from "../infra/triage-continuation.js";
import type { TriageFailureContext } from "./triage-prompt.js";
import {
  prepareStartupTriageValidator,
  startupTriageResultSchema,
  type StartupTriageResult,
} from "./triage-startup.js";

type JoinedTriage = Extract<
  Awaited<ReturnType<typeof continueTriageInFreshProcess>>,
  { status: "completed" }
>;
export async function readJoinedStartupTriageResult(params: {
  outcome: JoinedTriage;
  root: string;
  failure: TriageFailureContext;
  target: InstallationTarget;
  validate: Awaited<ReturnType<typeof prepareStartupTriageValidator>>;
  signal: AbortSignal;
  updateRunId?: string;
}): Promise<StartupTriageResult> {
  params.signal.throwIfAborted();
  if (
    params.outcome.installationRoot !== params.root ||
    params.outcome.commandOutput.kind !== "complete"
  ) {
    throw new Error("Startup repair has no matching joined result.");
  }
  const report = startupTriageResultSchema.parse(JSON.parse(params.outcome.commandOutput.stdout));
  const request = params.failure;
  if (
    report.installationRoot !== params.root ||
    report.generationOwner !== params.outcome.generationOwner ||
    report.failure.kind !== request.kind ||
    report.failure.phase !== request.phase ||
    report.failure.gateway !== request.gateway ||
    report.failure.expectedVersion !== request.expectedVersion
  ) {
    throw new Error(
      "Startup repair result does not match its original request and native generation.",
    );
  }
  const observed = await params.validate(params.signal, () => params.signal.throwIfAborted());
  // A new boot after child validation cannot inherit its claim, even on the same port/version.
  if (
    report.after.ok &&
    (!observed.ok ||
      observed.port !== report.after.port ||
      observed.bootId !== report.after.bootId ||
      observed.version !== report.after.version)
  ) {
    throw new Error(
      "Original-parent startup verification did not confirm the child's observed boot.",
    );
  }
  params.signal.throwIfAborted();
  if (report.repairTaskId) {
    // The old parent's lazy task graph may have been replaced after admission.
    // Optional projection cannot discard an independently verified repair result.
    const projection = await import("./triage-task-result.js").catch(() => undefined);
    projection?.settleTriageRepairTask({
      taskId: report.repairTaskId,
      outcome: params.outcome,
      root: params.root,
      target: params.target,
      updateRunId: params.updateRunId,
      startup: report,
      signal: params.signal,
    });
  }
  return report;
}
