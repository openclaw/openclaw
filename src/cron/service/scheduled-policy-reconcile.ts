import {
  constrainCronScheduledNativePolicy,
  normalizeCronScheduledNativePolicy,
  type CronScheduledNativePolicy,
} from "../scheduled-native-policy.js";
import {
  createTrustedCronScheduledToolPolicy,
  resolveCronScheduledToolPolicy,
  type CronScheduledToolPolicy,
} from "../scheduled-tool-policy.js";
import { cronJobUsesToolRuntime } from "../tools-allow.js";
import type { CronJob } from "../types.js";

export type CronScheduledPolicyInputs = {
  scheduledToolPolicy?: CronScheduledToolPolicy;
  scheduledNativePolicy?: CronScheduledNativePolicy;
};

function stampScheduledToolPolicy(
  job: CronJob,
  scheduledToolPolicy: CronScheduledToolPolicy | undefined,
): void {
  if (!cronJobUsesToolRuntime(job) || job.payload.toolsAllow === undefined) {
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

function stampScheduledNativePolicy(
  job: CronJob,
  scheduledNativePolicy: CronScheduledNativePolicy | undefined,
): void {
  if (job.payload.kind !== "agentTurn" || job.payload.toolsAllow === undefined) {
    delete job.scheduledNativePolicy;
    return;
  }
  const normalized = normalizeCronScheduledNativePolicy(scheduledNativePolicy);
  if (job.scheduledToolPolicy?.mode === "account" && !normalized) {
    throw new Error("account-scoped cron authority requires signed native creator provenance");
  }
  const policy = constrainCronScheduledNativePolicy({
    scheduledNativePolicy: normalized,
    toolsAllow: job.payload.toolsAllow,
    toolsAllowIsDefault: job.payload.toolsAllowIsDefault,
  });
  if (!policy) {
    delete job.scheduledNativePolicy;
    return;
  }
  job.scheduledNativePolicy = policy;
}

export function stampCronScheduledPolicies(job: CronJob, inputs: CronScheduledPolicyInputs): void {
  stampScheduledToolPolicy(job, inputs.scheduledToolPolicy);
  stampScheduledNativePolicy(job, inputs.scheduledNativePolicy);
}

export function reconcileCronScheduledPolicies(
  params: {
    job: CronJob;
    previouslyUsedToolRuntime: boolean;
    explicitlyMutatesToolsAllow: boolean;
  } & CronScheduledPolicyInputs,
): void {
  const { job } = params;
  if (!cronJobUsesToolRuntime(job) || job.payload.toolsAllow === undefined) {
    delete job.scheduledToolPolicy;
    delete job.scheduledNativePolicy;
    return;
  }

  const currentToolPolicy = resolveCronScheduledToolPolicy({
    toolsAllow: job.payload.toolsAllow,
    scheduledToolPolicy: job.scheduledToolPolicy,
    owner: job.owner,
  });
  if (currentToolPolicy) {
    job.scheduledToolPolicy = currentToolPolicy;
  } else {
    delete job.scheduledToolPolicy;
    if (params.explicitlyMutatesToolsAllow || !params.previouslyUsedToolRuntime) {
      stampScheduledToolPolicy(job, params.scheduledToolPolicy);
    }
  }

  if (job.payload.kind !== "agentTurn") {
    delete job.scheduledNativePolicy;
    return;
  }
  const currentNativePolicy = normalizeCronScheduledNativePolicy(job.scheduledNativePolicy);
  if (params.explicitlyMutatesToolsAllow || !params.previouslyUsedToolRuntime) {
    stampScheduledNativePolicy(job, params.scheduledNativePolicy);
  } else if (currentNativePolicy) {
    const constrained = constrainCronScheduledNativePolicy({
      scheduledNativePolicy: currentNativePolicy,
      toolsAllow: job.payload.toolsAllow,
      toolsAllowIsDefault: job.payload.toolsAllowIsDefault,
    });
    if (constrained) {
      job.scheduledNativePolicy = constrained;
    } else {
      delete job.scheduledNativePolicy;
    }
  } else {
    // Missing/invalid persisted provenance remains visible to preflight and Doctor.
    delete job.scheduledNativePolicy;
  }
}
