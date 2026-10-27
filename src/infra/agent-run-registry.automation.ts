import { parseAutomationResult } from "../cron/automation-result.js";
import {
  getAgentRunContext,
  getAgentRunContextOwnership,
  hasAgentRunContextExecutionOwner,
  getAgentRunLifecycleGeneration,
  validateAgentRunDelegatedAuthority,
} from "./agent-run-registry.js";
import type { AutomationResult } from "./agent-run-registry.types.js";

/** Presentation reads the existing invocation; it never decides execution or delivery. */
export function readAutomationDisplayState(
  runId: string | undefined,
): "ordinary" | "checking" | "quiet" {
  const invocations = runId ? getAgentRunContext(runId)?.cronRunsByJobId : undefined;
  if (!invocations?.size) {
    return "ordinary";
  }
  for (const invocation of invocations.values()) {
    if (invocation.result?.outcome === "no_change") {
      return "quiet";
    }
  }
  return "checking";
}

/** Records the latest next-check proposal on the matching live cron run. */
export function recordCronNextCheckProposal(runId: string, jobId: string, delayMs: number): void {
  const context = getAgentRunContext(runId);
  const cronRun = context?.cronRunsByJobId?.get(jobId);
  if (!cronRun || !hasAgentRunContextExecutionOwner(runId)) {
    throw new Error("cron next_check is only available to the currently running job");
  }
  if (!cronRun.nextCheckEnabled) {
    throw new Error("cron next_check requires pacing or a one-shot session continuation");
  }
  cronRun.nextCheckMs = delayMs;
}

/** Capture the invocation itself so recycled run and job IDs never renew a retained tool. */
export function createAutomationRunGuard(runId: string, jobId: string): () => void {
  const context = getAgentRunContext(runId);
  const run = context?.cronRunsByJobId?.get(jobId);
  const owners = getAgentRunContextOwnership(runId);
  const claims = new Set(owners?.claimIds);
  const delegatedAuthority = context?.delegatedAuthority;
  return () => {
    if (
      !context ||
      !run?.assertCurrent ||
      run.closed ||
      getAgentRunContext(runId) !== context ||
      context.cronRunsByJobId?.get(jobId) !== run ||
      context.lifecycleGeneration !== getAgentRunLifecycleGeneration() ||
      (owners &&
        (getAgentRunContextOwnership(runId) !== owners ||
          owners.clearRequested ||
          ![...claims].some((claim) => owners.claimIds.has(claim)))) ||
      (delegatedAuthority && !validateAgentRunDelegatedAuthority(delegatedAuthority))
    ) {
      throw new Error("Automation invocation is no longer active");
    }
    run.assertCurrent();
  };
}

/** Accept one structured result while this exact invocation still owns execution. */
export function createAutomationResultRecorder(
  runId: string,
  jobId: string,
): (result: unknown) => AutomationResult {
  const run = getAgentRunContext(runId)?.cronRunsByJobId?.get(jobId);
  const assertCurrent = createAutomationRunGuard(runId, jobId);
  return (result) => {
    assertCurrent();
    if (!run) {
      throw new Error("record_result is only available to the currently running automation");
    }
    if (run.result) {
      throw new Error("record_result already accepted for this automation run");
    }
    const normalized = parseAutomationResult(result);
    if (!normalized) {
      throw new Error(
        "record_result requires a valid outcome and trimmed summary of 1–2000 characters (optional only for no_change)",
      );
    }
    run.result = normalized;
    return normalized;
  };
}

/** Consumes one successful cron run's proposal so it cannot affect a later run. */
export function consumeCronNextCheckProposal(runId: string, jobId: string): number | undefined {
  const context = getAgentRunContext(runId);
  const cronRuns = context?.cronRunsByJobId;
  const cronRun = cronRuns?.get(jobId);
  if (!cronRun) {
    return undefined;
  }
  cronRuns?.delete(jobId);
  if (cronRuns?.size === 0 && context) {
    delete context.cronRunsByJobId;
  }
  return cronRun.nextCheckMs;
}
