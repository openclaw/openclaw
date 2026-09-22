import { isDeepStrictEqual } from "node:util";
import { isRuntimeToolAllowed } from "../../agents/tool-policy-match.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { cloneCronRuntimeAuthority, type CronRuntimeAuthority } from "../runtime-authority.js";
import {
  createTrustedCronScheduledToolPolicy,
  normalizeCronScheduledToolCallerOrigin,
  resolveCronScheduledToolPolicy,
  type CronScheduledToolPolicy,
} from "../scheduled-tool-policy.js";
import {
  normalizeCronToolsAllowProvenance,
  resolveCronAuthenticatedChannelRequester,
} from "../tools-allow-provenance.js";
import { cronJobUsesToolRuntime } from "../tools-allow.js";
import type {
  CronStoredJob,
  CronToolsAllowExecTarget,
  CronToolsAllowExecTargetRequirement,
  CronToolsAllowProvenance,
} from "../types.js";
import type { CronAddOptions, CronUpdateOptions } from "./state.js";

/** Snapshots the normalized permissions used by scheduled message access. */
export function resolveCronJobMessageActionAuthorityInputs(job: CronStoredJob) {
  const policy = resolveCronScheduledToolPolicy({
    toolsAllow: job.payload.toolsAllow,
    scheduledToolPolicy: job.scheduledToolPolicy,
    owner: job.owner,
  });
  if (
    !cronJobUsesToolRuntime(job) ||
    !policy ||
    !isRuntimeToolAllowed("message", job.payload.toolsAllow)
  ) {
    return undefined;
  }
  const channelRequester = resolveCronAuthenticatedChannelRequester(job);
  return {
    policy,
    ...(policy.mode === "account"
      ? {
          callerOrigin: normalizeCronScheduledToolCallerOrigin(
            job.toolsAllowProvenance?.callerOrigin,
          ),
          ...(channelRequester
            ? { channelRequester, executableRevision: resolveCronRequesterExecutionRevision(job) }
            : {}),
        }
      : {}),
  };
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

/** Binds native requester authority to executable inputs using the canonical storage projection. */
function resolveCronRequesterExecutionRevision(job: CronStoredJob): string {
  const {
    description: _description,
    displayName: _displayName,
    createdActor: _createdActor,
    toolsAllowProvenance: _toolsAllowProvenance,
    ...executableJob
  } = job;
  return resolveCronJobConfigRevision(executableJob);
}

/** Rebinds or clears native requester facts after the complete authored mutation is known. */
export function reconcileCronChannelRequesterAuthority(params: {
  job: CronStoredJob;
  previousJob?: CronStoredJob;
  toolsAllowProvenance?: CronToolsAllowProvenance;
  /** An explicit executable resave may refresh identity without changing the definition. */
  reauthorize?: boolean;
}): void {
  const { job, previousJob } = params;
  if (
    !job.toolsAllowProvenance?.channelRequester &&
    !previousJob?.toolsAllowProvenance?.channelRequester &&
    !params.toolsAllowProvenance?.channelRequester
  ) {
    return;
  }
  const captured = normalizeCronToolsAllowProvenance(params.toolsAllowProvenance);
  const current = normalizeCronToolsAllowProvenance(job.toolsAllowProvenance);
  const previous = normalizeCronToolsAllowProvenance(previousJob?.toolsAllowProvenance);
  const unchangedCap =
    previousJob !== undefined &&
    isDeepStrictEqual(previousJob.payload.toolsAllow, job.payload.toolsAllow) &&
    (previousJob.payload.toolsAllowIsDefault === true) ===
      (job.payload.toolsAllowIsDefault === true);
  const fullSurface =
    current?.source === "final-executable-surface"
      ? current
      : unchangedCap && previous?.source === "final-executable-surface"
        ? previous
        : undefined;

  const executionUnchanged =
    previousJob !== undefined &&
    resolveCronRequesterExecutionRevision(previousJob) ===
      resolveCronRequesterExecutionRevision(job) &&
    isDeepStrictEqual(previousJob.state.triggerState, job.state.triggerState);
  const acceptsCapture = !executionUnchanged || params.reauthorize === true;
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

  if (fullSurface) {
    const { channelRequester: _previousRequester, ...provenance } = fullSurface;
    job.toolsAllowProvenance = {
      ...provenance,
      ...(channelRequester ? { channelRequester } : {}),
    };
  } else if (channelRequester) {
    job.toolsAllowProvenance = {
      version: 1,
      source: "authenticated-requester",
      channelRequester,
    };
  } else {
    delete job.toolsAllowProvenance;
  }
}

export function consumeRuntimeAuthorityMutationOptions(
  opts: CronAddOptions | CronUpdateOptions | undefined,
): Pick<Parameters<typeof reconcileRuntimeAuthority>[0], "captured" | "runtimeAuthority"> {
  // Validation-only guards must not look like an empty fresh capture: that
  // would erase an existing runtime ceiling during an otherwise routine edit.
  opts?.commitGuard?.();
  return {
    captured: opts?.captureRuntimeAuthority !== undefined,
    runtimeAuthority: opts?.captureRuntimeAuthority?.(),
  };
}

function stampScheduledToolPolicy(
  job: CronStoredJob,
  scheduledToolPolicy: CronScheduledToolPolicy | null | undefined,
): void {
  if (
    !cronJobUsesToolRuntime(job) ||
    job.payload.toolsAllow === undefined ||
    scheduledToolPolicy === null
  ) {
    delete job.scheduledToolPolicy;
    return;
  }
  const policy = scheduledToolPolicy ?? createTrustedCronScheduledToolPolicy();
  if (
    policy.mode === "account" &&
    (job.owner?.sessionKey !== policy.ownerSessionKey ||
      job.owner?.accountId !== policy.ownerAccountId)
  ) {
    throw new Error("scheduled account policy must match the persisted job owner");
  }
  job.scheduledToolPolicy = structuredClone(policy);
}

function reconcileScheduledToolPolicy(params: {
  job: CronStoredJob;
  previouslyUsedToolRuntime: boolean;
  explicitlyMutatesToolsAllow: boolean;
  scheduledToolPolicy?: CronScheduledToolPolicy | null;
}): void {
  const { job } = params;
  const current = resolveCronScheduledToolPolicy({
    toolsAllow: job.payload.toolsAllow ?? [],
    scheduledToolPolicy: job.scheduledToolPolicy,
    owner: job.owner,
  });
  if (!cronJobUsesToolRuntime(job) || job.payload.toolsAllow === undefined) {
    // A dormant account binding is still its ceiling. Dropping it would let
    // a later operator payload conversion silently adopt trusted authority.
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
  if (params.explicitlyMutatesToolsAllow || !params.previouslyUsedToolRuntime) {
    stampScheduledToolPolicy(job, params.scheduledToolPolicy);
  }
}

/**
 * Stamps or clears the restrict-only exec pin alongside the cap it was
 * captured with. The pin exists only while the job grants canonical `exec`
 * from a creator surface whose exec capability was host-pinned; explicit cap
 * rewrites without that server-verified fact clear it, falling back to the
 * baseline unpinned exec policy.
 */
function reconcileToolsAllowExecTarget(params: {
  job: CronStoredJob;
  explicitlyMutatesToolsAllow: boolean;
  toolsAllowExecTarget?: CronToolsAllowExecTarget;
}): void {
  const { job } = params;
  if (!cronJobUsesToolRuntime(job) || job.payload.toolsAllow === undefined) {
    delete job.toolsAllowExecTarget;
    delete job.toolsAllowExecTargetRequirement;
    return;
  }
  if (!params.explicitlyMutatesToolsAllow) {
    return;
  }
  const grantsExec =
    Array.isArray(job.payload.toolsAllow) && job.payload.toolsAllow.includes("exec");
  if (params.toolsAllowExecTarget && grantsExec) {
    job.toolsAllowExecTarget = structuredClone(params.toolsAllowExecTarget);
    job.toolsAllowExecTargetRequirement = {
      version: 1,
      target: structuredClone(params.toolsAllowExecTarget),
      grantIndex: job.payload.toolsAllow.indexOf("exec"),
    } satisfies CronToolsAllowExecTargetRequirement;
  } else {
    delete job.toolsAllowExecTarget;
    delete job.toolsAllowExecTargetRequirement;
  }
}

function reconcileToolsAllowProvenance(params: {
  job: CronStoredJob;
  explicitlyMutatesToolsAllow: boolean;
  toolsAllowProvenance?: CronToolsAllowProvenance;
}): void {
  if (!params.explicitlyMutatesToolsAllow) {
    return;
  }
  if (
    cronJobUsesToolRuntime(params.job) &&
    params.job.payload.toolsAllow !== undefined &&
    params.toolsAllowProvenance?.version === 1 &&
    params.toolsAllowProvenance.source === "final-executable-surface"
  ) {
    params.job.toolsAllowProvenance = structuredClone(params.toolsAllowProvenance);
    return;
  }
  delete params.job.toolsAllowProvenance;
}

/** Reconciles runtime-owned opaque authority with the mutation that owns this write. */
export function reconcileRuntimeAuthority(params: {
  job: CronStoredJob;
  captured: boolean;
  runtimeAuthority?: CronRuntimeAuthority;
  explicitlyMutatesToolsAllow: boolean;
}): void {
  if (!cronJobUsesToolRuntime(params.job)) {
    // Runtime authority cannot survive a payload transition into a path that
    // does not execute the captured tool surface and later reappear on reuse.
    delete params.job.runtimeAuthority;
    delete params.job.runtimeAuthorityRecoveryRequired;
    return;
  }
  if (params.captured) {
    delete params.job.runtimeAuthorityRecoveryRequired;
    const runtimeAuthority = params.runtimeAuthority
      ? cloneCronRuntimeAuthority(params.runtimeAuthority)
      : undefined;
    if (params.runtimeAuthority && !runtimeAuthority) {
      throw new TypeError("captured cron runtime authority is invalid");
    }
    if (runtimeAuthority) {
      params.job.runtimeAuthority = runtimeAuthority;
    } else {
      // A fresh exact-surface capture with no runtime authority intentionally
      // replaces any older runtime-specific grant instead of retaining it.
      delete params.job.runtimeAuthority;
    }
    return;
  }
  if (params.explicitlyMutatesToolsAllow) {
    // Explicit tool caps are a complete replacement. Runtime-owned authority
    // may be restored only by another authenticated exact-surface capture.
    if (params.job.runtimeAuthority) {
      params.job.runtimeAuthorityRecoveryRequired = true;
      delete params.job.runtimeAuthority;
    }
  }
}

/** Reconciles the scheduled policy, capture provenance, and exec pin as one cap-authority unit. */
export function reconcileToolsAllowAuthority(params: {
  job: CronStoredJob;
  previouslyUsedToolRuntime: boolean;
  explicitlyMutatesToolsAllow: boolean;
  scheduledToolPolicy?: CronScheduledToolPolicy | null;
  toolsAllowProvenance?: CronToolsAllowProvenance;
  toolsAllowExecTarget?: CronToolsAllowExecTarget;
}): void {
  reconcileScheduledToolPolicy(params);
  reconcileToolsAllowProvenance(params);
  reconcileToolsAllowExecTarget(params);
}
