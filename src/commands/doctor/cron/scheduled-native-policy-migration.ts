import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  constrainCronScheduledNativePolicy,
  deriveCronScheduledNativePolicy,
  normalizeCronScheduledNativePolicy,
} from "../../../cron/scheduled-native-policy.js";

type ScheduledNativePolicyMigrationResult = {
  mutated: boolean;
  status: "current" | "migrated" | "legacy" | "invalid" | "not-applicable";
};

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function migrateScheduledNativePolicy(
  raw: Record<string, unknown>,
  onMigrated: (policy: { version: 1; mode: "inherit" | "disabled" }) => void,
): ScheduledNativePolicyMigrationResult {
  const payload = readRecord(raw.payload);
  if (payload?.kind !== "agentTurn") {
    return {
      mutated: false,
      status: raw.scheduledNativePolicy === undefined ? "not-applicable" : "invalid",
    };
  }
  if (raw.scheduledNativePolicy !== undefined) {
    const normalized = normalizeCronScheduledNativePolicy(raw.scheduledNativePolicy);
    if (!normalized) {
      return { mutated: false, status: "invalid" };
    }
    if (
      !Array.isArray(payload.toolsAllow) ||
      !payload.toolsAllow.every((value): value is string => typeof value === "string")
    ) {
      return { mutated: false, status: "invalid" };
    }
    const constrained = constrainCronScheduledNativePolicy({
      scheduledNativePolicy: normalized,
      toolsAllow: payload.toolsAllow,
      toolsAllowIsDefault: payload.toolsAllowIsDefault === true,
    });
    if (!constrained) {
      return { mutated: false, status: "invalid" };
    }
    const mutated = JSON.stringify(raw.scheduledNativePolicy) !== JSON.stringify(constrained);
    if (mutated) {
      raw.scheduledNativePolicy = constrained;
      onMigrated(constrained);
    }
    return { mutated, status: mutated ? "migrated" : "current" };
  }
  if (
    !Array.isArray(payload.toolsAllow) ||
    !payload.toolsAllow.every((value): value is string => typeof value === "string")
  ) {
    return { mutated: false, status: "legacy" };
  }
  const policy = deriveCronScheduledNativePolicy(payload.toolsAllow);
  if (!policy) {
    return { mutated: false, status: "legacy" };
  }
  raw.scheduledNativePolicy = policy;
  onMigrated(policy);
  return { mutated: true, status: "migrated" };
}

/** Collects scheduled-native migration outcomes during cron store normalization. */
export function createScheduledNativePolicyMigrationCollector() {
  const legacyJobs: string[] = [];
  const invalidJobs: string[] = [];
  return {
    legacyJobs,
    invalidJobs,
    migrate(
      raw: Record<string, unknown>,
      onMigrated: (policy: { version: 1; mode: "inherit" | "disabled" }) => void,
    ) {
      let migratedPolicy: { version: 1; mode: "inherit" | "disabled" } | undefined;
      const result = migrateScheduledNativePolicy(raw, (policy) => {
        migratedPolicy = policy;
      });
      const jobName = normalizeOptionalString(raw.name) ?? normalizeOptionalString(raw.id);
      if (result.status === "migrated" && migratedPolicy) {
        onMigrated(migratedPolicy);
      } else if (result.status === "legacy" && jobName) {
        legacyJobs.push(jobName);
      } else if (result.status === "invalid" && jobName) {
        invalidJobs.push(jobName);
      }
      return result.mutated;
    },
  };
}
