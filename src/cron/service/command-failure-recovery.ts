/** Command failures create one recovery job in the parent's finalization transaction. */
import { sha256Hex } from "../../infra/crypto-digest.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import type { CronRunReceiptHandle } from "../store/run-receipt.types.js";
import { COMMAND_RECOVERY_DECLARATION_PREFIX } from "../system-owned-declaration.js";
import type { CronCompletionStatus, CronJob, CronRunStatus } from "../types.js";
import { createJob } from "./jobs.js";
import type { CronServiceState } from "./state.js";

export function planCommandFailureRecovery(
  state: {
    deps: Pick<CronServiceState["deps"], "nowMs" | "cronConfig" | "defaultAgentId" | "log">;
  },
  job: CronJob,
  outcome: {
    status: CronRunStatus;
    completionStatus?: CronCompletionStatus;
    endedAt: number;
    runReceipt?: Pick<CronRunReceiptHandle, "receiptId" | "configRevision">;
  },
  jobs: ReadonlyMap<string, CronJob>,
  previousChildHasActiveReceipt: boolean,
): CronJob | undefined {
  if (job.payload.kind !== "command" || job.state.commandRecoveryOrigin) {
    return undefined;
  }
  const parentConfigRevision = resolveCronJobConfigRevision(job);
  if (parentConfigRevision !== outcome.runReceipt?.configRevision) {
    return undefined;
  }
  const previous = job.state.failureRecovery;
  if (outcome.status === "ok" && outcome.completionStatus !== "failed") {
    if (previous) {
      previous.recoveredAtMs = outcome.endedAt;
    }
    return undefined;
  }
  const policy = job.failureRecovery;
  const receiptId = outcome.runReceipt?.receiptId;
  if (outcome.status !== "error" || !policy || !receiptId || !job.enabled) {
    return undefined;
  }
  if (previous) {
    const child = jobs.get(previous.jobId);
    // Missing retained evidence is uncertainty, not permission for another attempt.
    if (
      previous.recoveredAtMs === undefined ||
      previousChildHasActiveReceipt ||
      !child ||
      child.enabled ||
      child.state.queuedAtMs !== undefined ||
      child.state.runningAtMs !== undefined
    ) {
      return undefined;
    }
  }
  const identity = sha256Hex(JSON.stringify([job.id, receiptId]));
  const childId = `command-recovery-${identity}`;
  let child: CronJob;
  try {
    child = createJob(state, {
      id: childId,
      declarationKey: `${COMMAND_RECOVERY_DECLARATION_PREFIX}${identity}`,
      name: `Command recovery ${job.id}`,
      agentId: policy.agentId,
      enabled: true,
      deleteAfterRun: false,
      schedule: { kind: "at", at: new Date(outcome.endedAt).toISOString() },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        ...(policy.toolsAllow === undefined ? {} : { toolsAllow: [...policy.toolsAllow] }),
        timeoutSeconds: policy.timeoutSeconds ?? 2_400,
        message: [
          "Scheduler-authored command failure recovery. This is not a human request.",
          `Parent automation: ${job.id}. Failed execution receipt: ${receiptId}.`,
          "The command's original failure remains recorded. Your turn completing does not verify repair.",
          "Inspect authorized native evidence. Make at most one bounded corrective attempt; verify the owning result.",
          "Do not manage or force-run automations, create recursive recovery, blindly restart, or send an automatic human reply.",
          "This turn grants no additional authority. If blocked, record the durable blocker using authorized evidence.",
          "Operator-authorized recovery instructions:",
          policy.message,
        ].join("\n"),
      },
      delivery: { mode: "none" },
      failureAlert: false,
    });
  } catch (error) {
    // Malformed legacy policy cannot roll back the command's terminal result.
    state.deps.log.warn(
      { jobId: job.id, receiptId, error: String(error) },
      "cron: command failure recovery could not be admitted",
    );
    return undefined;
  }
  child.state.commandRecoveryOrigin = {
    jobId: job.id,
    failedReceiptId: receiptId,
    parentConfigRevision,
  };
  job.state.failureRecovery = { jobId: childId, failedReceiptId: receiptId };
  return child;
}
