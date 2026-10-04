import { isDeepStrictEqual } from "node:util";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import {
  createTrustedCronScheduledToolPolicy,
  normalizeCronScheduledToolCallerOrigin,
  resolveCronScheduledToolPolicy,
  type CronScheduledToolPolicy,
} from "../scheduled-tool-policy.js";
import {
  normalizeCronToolsAllowProvenance,
  resolveCronAuthenticatedCallerOrigin,
  resolveCronAuthenticatedChannelRequester,
} from "../tools-allow-provenance.js";
import { cronJobUsesToolRuntime } from "../tools-allow.js";
import type { CronStoredJob, CronToolsAllowProvenance } from "../types.js";

/** Preserve the authenticated owner independently of the creator turn's old tool inventory. */
export function reconcileScheduledJobOwnerPolicy(params: {
  job: CronStoredJob;
  previouslyUsedToolRuntime: boolean;
  scheduledToolPolicy?: CronScheduledToolPolicy | null;
}): void {
  const { job } = params;
  const current = resolveCronScheduledToolPolicy({
    scheduledToolPolicy: job.scheduledToolPolicy,
    owner: job.owner,
  });
  if (!cronJobUsesToolRuntime(job)) {
    // A dormant account binding must survive a later conversion back to tools.
    if (current?.mode === "account") {
      job.scheduledToolPolicy = current;
    } else {
      delete job.scheduledToolPolicy;
    }
    return;
  }
  if (current) {
    job.scheduledToolPolicy = current;
    return;
  }
  delete job.scheduledToolPolicy;
  if (params.scheduledToolPolicy === null) {
    return;
  }
  const policy =
    params.scheduledToolPolicy ??
    (!params.previouslyUsedToolRuntime ? createTrustedCronScheduledToolPolicy() : undefined);
  if (!policy) {
    return;
  }
  if (
    policy.mode === "account" &&
    (job.owner?.sessionKey !== policy.ownerSessionKey ||
      job.owner?.accountId !== policy.ownerAccountId)
  ) {
    throw new Error("scheduled account policy must match the persisted job owner");
  }
  job.scheduledToolPolicy = structuredClone(policy);
}

/** Snapshots the permissions used by all scheduled message actions. */
export function resolveCronJobMessageToolAuthorityInputs(job: CronStoredJob) {
  const policy = resolveCronJobScheduledMessagePolicy(job);
  return policy ? { policy } : undefined;
}

/** Snapshots the normalized permissions used by scheduled message access. */
export function resolveCronJobMessageActionAuthorityInputs(job: CronStoredJob) {
  const policy = resolveCronJobScheduledMessagePolicy(job);
  if (!policy) {
    return undefined;
  }
  const channelRequester = resolveCronAuthenticatedChannelRequester(job);
  const callerOrigin = normalizeCronScheduledToolCallerOrigin(
    job.toolsAllowProvenance?.callerOrigin,
  );
  return {
    policy,
    ...(policy.mode === "account"
      ? {
          callerOrigin,
          ...(channelRequester || callerOrigin.kind !== "unknown"
            ? {
                ...(channelRequester ? { channelRequester } : {}),
                executableRevision: resolveCronRequesterExecutionRevision(job),
              }
            : {}),
        }
      : {}),
  };
}

export function cronJobMessageToolAuthorityInputsEqual(
  previous: CronStoredJob,
  next: CronStoredJob,
): boolean {
  return isDeepStrictEqual(
    resolveCronJobMessageToolAuthorityInputs(previous),
    resolveCronJobMessageToolAuthorityInputs(next),
  );
}

export function cronJobMessageActionAuthorityInputsEqual(
  previous: CronStoredJob,
  next: CronStoredJob,
): boolean {
  return isDeepStrictEqual(
    resolveCronJobMessageActionAuthorityInputs(previous),
    resolveCronJobMessageActionAuthorityInputs(next),
  );
}

/** Rebinds or clears authenticated requester facts after the complete mutation is known. */
export function reconcileCronChannelRequesterAuthority(params: {
  job: CronStoredJob;
  previousJob?: CronStoredJob;
  toolsAllowProvenance?: CronToolsAllowProvenance;
  /** An explicit declaration resave may refresh its requester without changing the definition. */
  reauthorize?: boolean;
}): void {
  const { job, previousJob } = params;
  if (
    !job.toolsAllowProvenance?.callerOrigin &&
    !job.toolsAllowProvenance?.channelRequester &&
    !previousJob?.toolsAllowProvenance?.callerOrigin &&
    !previousJob?.toolsAllowProvenance?.channelRequester &&
    !params.toolsAllowProvenance?.callerOrigin &&
    !params.toolsAllowProvenance?.channelRequester
  ) {
    return;
  }
  const captured = normalizeCronToolsAllowProvenance(params.toolsAllowProvenance);
  const previous = normalizeCronToolsAllowProvenance(previousJob?.toolsAllowProvenance);

  const executionUnchanged =
    previousJob !== undefined &&
    resolveCronRequesterExecutionRevision(previousJob) ===
      resolveCronRequesterExecutionRevision(job) &&
    isDeepStrictEqual(previousJob.state.triggerState, job.state.triggerState);
  const acceptsCapture = !executionUnchanged || params.reauthorize === true;
  let callerOrigin =
    cronJobUsesToolRuntime(job) && !executionUnchanged
      ? resolveCronAuthenticatedCallerOrigin({ ...job, toolsAllowProvenance: captured })
      : undefined;
  if (!callerOrigin && previousJob && cronJobUsesToolRuntime(job) && executionUnchanged) {
    callerOrigin = resolveCronAuthenticatedCallerOrigin({
      ...job,
      toolsAllowProvenance: previous,
    });
  }
  let channelRequester =
    cronJobUsesToolRuntime(job) && acceptsCapture
      ? resolveCronAuthenticatedChannelRequester({ ...job, toolsAllowProvenance: captured })
      : undefined;
  if (
    !channelRequester &&
    (!acceptsCapture || params.toolsAllowProvenance?.channelRequester === undefined) &&
    previousJob &&
    cronJobUsesToolRuntime(job) &&
    executionUnchanged
  ) {
    channelRequester = resolveCronAuthenticatedChannelRequester({
      ...job,
      toolsAllowProvenance: previous,
    });
  }

  if (callerOrigin) {
    job.toolsAllowProvenance = {
      version: 1,
      source: "authenticated-requester",
      callerOrigin,
      ...(channelRequester ? { channelRequester } : {}),
    };
  } else if (channelRequester) {
    job.toolsAllowProvenance = { version: 1, source: "authenticated-requester", channelRequester };
  } else {
    delete job.toolsAllowProvenance;
  }
}

function resolveCronJobScheduledMessagePolicy(job: CronStoredJob) {
  const policy = resolveCronScheduledToolPolicy({
    scheduledToolPolicy: job.scheduledToolPolicy,
    owner: job.owner,
  });
  return cronJobUsesToolRuntime(job) ? policy : undefined;
}

/** Binds native requester authority to executable inputs using the canonical storage projection. */
function resolveCronRequesterExecutionRevision(job: CronStoredJob): string {
  const {
    description: _description,
    displayName: _displayName,
    createdActor: _createdActor,
    toolsAllowProvenance: _toolsAllowProvenance,
    toolsAllowExecTarget: _toolsAllowExecTarget,
    toolsAllowExecTargetRequirement: _toolsAllowExecTargetRequirement,
    payload,
    ...executableJob
  } = job;
  const {
    toolsAllow: _toolsAllow,
    toolsAllowIsDefault: _toolsAllowIsDefault,
    ...executablePayload
  } = payload;
  return resolveCronJobConfigRevision({ ...executableJob, payload: executablePayload });
}
