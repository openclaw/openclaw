import { createUpdateErrorFact } from "../../infra/update-failure-facts.js";
import { FreeBsdPkgOwnershipError } from "../../infra/update-freebsd-pkg-ownership.js";
import type { UpdateRestartSentinelMeta } from "../../infra/update-restart-sentinel-payload.js";
import {
  finishUpdateRun,
  heartbeatUpdateRun,
  recordUpdateRunPhase,
  recordUpdateRunDiagnostics,
  recordUpdateRunStep,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import { updateRunStepsFromResultStep } from "../../infra/update-run-step.js";
import type { UpdateRunResult, UpdateRunnerOptions } from "../../infra/update-runner-types.js";

export function createUpdateRunRecording(
  runId: string,
  driver: UpdateRunRecord["origin"]["driver"],
  sentinelMeta: UpdateRestartSentinelMeta,
): Pick<UpdateRunnerOptions, "beforeGitMutation" | "progress"> {
  return {
    beforeGitMutation: async ({ sha, version }) => {
      recordUpdateRunPhase(runId, "staging", {
        target: { ...(sha ? { sha } : {}), ...(version ? { version } : {}) },
      });
      sentinelMeta.target = sha ?? version ?? sentinelMeta.target;
    },
    progress: {
      onHeartbeat: () => heartbeatUpdateRun(runId, driver),
      onRollbackOutcome: (rollbackOutcome) =>
        recordUpdateRunVerification(runId, { rollbackOutcome }),
      onStepStart: (step) =>
        recordUpdateRunStep(runId, {
          step: step.name,
          status: "in_progress",
          startedAtMs: Date.now(),
        }),
      onStepComplete: (step) => {
        for (const entry of updateRunStepsFromResultStep(step)) {
          recordUpdateRunStep(runId, { ...entry, endedAtMs: Date.now() });
        }
      },
    },
  };
}

export function createUnexpectedUpdateFailureResult(
  current: UpdateRunRecord,
  previous: UpdateRunResult,
  error: unknown,
): UpdateRunResult {
  const activeStep = current.steps.findLast((step) => step.status === "in_progress");
  const name = activeStep?.step ?? current.phase;
  return {
    ...previous,
    status: "error",
    mode: previous.mode === "unknown" && current.target.kind === "git" ? "git" : previous.mode,
    reason: error instanceof FreeBsdPkgOwnershipError ? error.reason : "unexpected-error",
    recovery: current.verification.recovery ?? previous.recovery,
    rollbackOutcome: current.verification.rollbackOutcome ??
      previous.rollbackOutcome ?? {
        status: "not-attempted",
        reason: "Gateway RPC does not perform rollback after an unexpected exception",
      },
    before: previous.before ?? current.before,
    after: previous.after ?? current.after,
    steps: [
      ...previous.steps,
      {
        name,
        command: "",
        cwd: previous.root ?? "",
        durationMs: Date.now() - (activeStep?.startedAtMs ?? current.createdAtMs),
        exitCode: 1,
        failureFacts: [createUpdateErrorFact(name, error)],
      },
    ],
    durationMs: Date.now() - current.createdAtMs,
  };
}

export async function recordUpdateRunResult(
  runId: string,
  result: UpdateRunResult,
  params: {
    nextAction?: string;
    handoffStarted: boolean;
    notifyActivating: (run: UpdateRunRecord) => Promise<unknown>;
    warn: (message: string) => void;
  },
): Promise<UpdateRunRecord> {
  recordUpdateRunDiagnostics(runId, result, params.warn);
  if (result.status === "ok") {
    const activating = recordUpdateRunPhase(runId, "activating", {
      before: result.before,
      after: result.after,
    });
    await params.notifyActivating(activating);
  }
  let outcomeRun = recordUpdateRunPhase(
    runId,
    result.status === "ok" ? "restarting" : "requested",
    {
      before: result.before,
      after: result.after,
      ...(params.nextAction ? { origin: { nextAction: params.nextAction } } : {}),
    },
  );
  for (const step of result.steps) {
    for (const entry of updateRunStepsFromResultStep(step)) {
      if (entry.step === step.name && step.exitCode === null && result.status !== "error") {
        entry.status = "completed";
        delete entry.detail;
      }
      recordUpdateRunStep(runId, entry);
    }
  }
  // A managed orchestrator or the replacement Gateway owns terminal success;
  // refusals and synchronous failures have no later process to finish the run.
  if (result.status !== "ok" && !params.handoffStarted) {
    outcomeRun = finishUpdateRun(runId, {
      status: result.status === "skipped" ? "skipped" : "failed",
      reason: result.reason,
      after: result.after,
    });
  }

  return outcomeRun;
}
