import {
  constrainCronScheduledNativePolicy,
  normalizeCronScheduledNativePolicy,
  type CronScheduledNativePolicy,
} from "../scheduled-native-policy.js";
import {
  resolveCronScheduledToolPolicy,
  type CronScheduledToolPolicy,
} from "../scheduled-tool-policy.js";
import type { CronJob } from "../types.js";

type ScheduledCronAuthority = {
  scheduledNativePolicy?: CronScheduledNativePolicy;
  scheduledToolPolicy?: CronScheduledToolPolicy;
};

type ScheduledCronAuthorityResult =
  | ({ ok: true } & ScheduledCronAuthority)
  | { ok: false; error: string };

export function resolveScheduledCronAuthority(job: CronJob): ScheduledCronAuthorityResult {
  if (job.payload.kind !== "agentTurn") {
    return { ok: true };
  }

  const scheduledNativePolicy = normalizeCronScheduledNativePolicy(job.scheduledNativePolicy);
  const toolsAllow =
    Array.isArray(job.payload.toolsAllow) &&
    job.payload.toolsAllow.every((toolName) => typeof toolName === "string")
      ? job.payload.toolsAllow
      : undefined;
  const scheduledToolPolicy = resolveCronScheduledToolPolicy({
    toolsAllow,
    scheduledToolPolicy: job.scheduledToolPolicy,
    owner: job.owner,
  });
  const invalidScheduledToolPolicy =
    job.scheduledToolPolicy !== undefined && scheduledToolPolicy === undefined;
  const constrainedNativePolicy = constrainCronScheduledNativePolicy({
    scheduledNativePolicy,
    toolsAllow,
    toolsAllowIsDefault: job.payload.toolsAllowIsDefault,
  });
  const invalidNativePolicyForCap = scheduledNativePolicy?.mode !== constrainedNativePolicy?.mode;
  if (
    !toolsAllow ||
    !scheduledNativePolicy ||
    invalidNativePolicyForCap ||
    invalidScheduledToolPolicy
  ) {
    return {
      ok: false,
      error:
        "Scheduled authority is missing or invalid. Run `openclaw doctor --fix`, then explicitly reauthorize this automation from an authenticated agent session.",
    };
  }

  return { ok: true, scheduledNativePolicy, scheduledToolPolicy };
}
