import type { SessionCreatedActor } from "../config/sessions/session-entry-provenance.js";
import type { CronStoredJob } from "./types.js";

/** Legacy jobs keep their execution semantics until their human owner changes. */
export function hasTransferredCronOwner(
  job: Pick<CronStoredJob, "ownerProfileId" | "createdActor">,
): boolean {
  if (!job.ownerProfileId) {
    return false;
  }
  const creator = job.createdActor;
  return (
    creator?.type !== "human" || creator.source !== "profile" || creator.id !== job.ownerProfileId
  );
}

/** Audit provenance stays immutable; execution follows the current human owner. */
export function cronExecutionActor(
  job: Pick<CronStoredJob, "ownerProfileId" | "createdActor">,
): SessionCreatedActor | undefined {
  return job.ownerProfileId
    ? { type: "human", source: "profile", id: job.ownerProfileId }
    : job.createdActor;
}

/** Model runs must not borrow a retained session's previous owner's credentials. */
export function resolveCronOwnerTransferRecoveryError(
  job: Pick<CronStoredJob, "ownerTransferPending" | "payload">,
): string | undefined {
  if (
    job.ownerTransferPending &&
    (job.payload.kind === "agentTurn" || job.payload.kind === "systemEvent")
  ) {
    return "This automation needs fresh execution authority. Select an inference account or reauthorize it from an authenticated owner turn before running it.";
  }
  return undefined;
}

/** A management transfer is not permission to lend the previous person's credentials. */
export function retireTransferredCronAuthority(job: CronStoredJob): void {
  job.enabled = false;
  job.ownerTransferPending = true;
  delete job.state.nextRunAtMs;
  delete job.operatorSource;
  delete job.inferenceBinding;
  delete job.runtimeAuthority;
  job.runtimeAuthorityRecoveryRequired = true;
  delete job.toolsAllowProvenance;
  // Keep restrict-only sandbox and exec pins: losing them would broaden execution.
}
