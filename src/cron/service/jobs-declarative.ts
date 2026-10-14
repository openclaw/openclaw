import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { CronStoredJob } from "../types.js";

const CRON_DECLARATIVE_LABEL_MAX_LENGTH = 200;

export function normalizeDeclarativeLabel(
  value: unknown,
  field: "declarationKey" | "displayName",
  nullable = false,
): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!(nullable && value == null) && value !== undefined && !normalized) {
    throw new Error(`cron ${field} must not be blank`);
  }
  if (normalized && normalized.length > CRON_DECLARATIVE_LABEL_MAX_LENGTH) {
    throw new Error(
      `cron ${field} must be at most ${CRON_DECLARATIVE_LABEL_MAX_LENGTH} characters`,
    );
  }
  return normalized;
}

export function declarativeFields(job: CronStoredJob, includeEnabled: boolean) {
  return {
    schedule: job.schedule,
    pacing: job.pacing,
    trigger: job.trigger,
    payload: job.payload,
    scheduledToolPolicy: job.scheduledToolPolicy,
    toolsAllowProvenance: job.toolsAllowProvenance,
    toolsAllowExecTarget: job.toolsAllowExecTarget,
    runtimeAuthority: job.runtimeAuthority,
    runtimeAuthorityRecoveryRequired: job.runtimeAuthorityRecoveryRequired,
    delivery: job.delivery,
    displayName: job.displayName,
    ...(includeEnabled
      ? {
          enabled: job.enabled,
          autoDisabled: job.state.autoDisabled,
          streamRestartExhausted: job.state.streamRestartExhausted,
        }
      : {}),
  };
}
