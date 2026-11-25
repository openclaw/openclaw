import { parseAutomationResult } from "../cron/automation-result.js";
import { isCronRunSessionKey } from "../sessions/session-key-utils.js";
import {
  getAgentRunContext,
  getAgentRunContextOwnership,
  hasAgentRunContextExecutionOwner,
  getAgentRunLifecycleGeneration,
  listAgentRunsForSession,
  validateAgentRunDelegatedAuthority,
} from "./agent-run-registry.js";
import type { AutomationResult } from "./agent-run-registry.types.js";

export const CRON_RUN_ENDED_ERROR = "cron run has ended; inspect the result in its run record";

/**
 * A cron run is one-shot: once its executor's own run (the one carrying the job invocation) no
 * longer owns execution, it has finalized and no later turn may start there. An accepted
 * follow-up turn on the same session does not keep the origin alive. Results stay in their
 * durable records.
 */
export function isEndedCronRun(sessionKey: string): boolean {
  // The run id is part of the key, so the key alone names this run's one executor; callers
  // that have not resolved a physical session id yet get the same answer.
  return (
    isCronRunSessionKey(sessionKey) &&
    !listAgentRunsForSession({ sessionKey, anySessionId: true }).some(
      (run) =>
        getAgentRunContext(run.runId)?.cronRunsByJobId?.size &&
        hasAgentRunContextExecutionOwner(run.runId),
    )
  );
}

/**
 * Checks a producer's acceptance condition and the ended-cron-run rule now, and returns both for
 * the admission owner to recheck until it accepts (and then clears) the occurrence.
 */
export function cronRunAcceptance(
  sessionKey: string,
  producer: (() => void) | undefined,
): (() => void) | undefined {
  const assertAccepted = () => {
    producer?.();
    if (isEndedCronRun(sessionKey)) {
      throw new Error(CRON_RUN_ENDED_ERROR);
    }
  };
  assertAccepted();
  return assertAccepted;
}

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

/** A meaningful recorded result is the scheduled run's authored outcome, like a visible reply. */
export function hasMeaningfulAutomationResult(runId: string | undefined): boolean {
  const invocations = runId ? getAgentRunContext(runId)?.cronRunsByJobId : undefined;
  return [...(invocations?.values() ?? [])].some(
    (invocation) => invocation.result !== undefined && invocation.result.outcome !== "no_change",
  );
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
    const normalized = parseAutomationResult(result);
    if (run.result) {
      // Repeating the accepted result changes nothing, so it is not a failure.
      if (normalized?.outcome === run.result.outcome && normalized.summary === run.result.summary) {
        return run.result;
      }
      throw new Error("record_result already accepted for this automation run");
    }
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
