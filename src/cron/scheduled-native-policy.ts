import { isRecord } from "@openclaw/normalization-core/record-coerce";

/** Creator-derived ceiling for runtime-native capabilities on scheduled turns. */
export type CronScheduledNativePolicy = {
  version: 1;
  mode: "inherit" | "disabled";
};

export function createCronScheduledNativePolicy(
  mode: CronScheduledNativePolicy["mode"],
): CronScheduledNativePolicy {
  return { version: 1, mode };
}

/** Accepts only the closed v1 policy; unknown input must be reauthorized or migrated. */
export function normalizeCronScheduledNativePolicy(
  value: unknown,
): CronScheduledNativePolicy | undefined {
  if (!isRecord(value) || value.version !== 1) {
    return undefined;
  }
  if (value.mode !== "inherit" && value.mode !== "disabled") {
    return undefined;
  }
  if (Object.keys(value).some((key) => key !== "version" && key !== "mode")) {
    return undefined;
  }
  return { version: 1, mode: value.mode };
}

/** Trusted/operator and shipped-job migration rule based on the durable OpenClaw cap. */
export function deriveCronScheduledNativePolicy(
  toolsAllow: readonly string[] | undefined,
): CronScheduledNativePolicy | undefined {
  if (!toolsAllow) {
    return undefined;
  }
  return createCronScheduledNativePolicy(
    toolsAllow.some((name) => name.trim() === "*") ? "inherit" : "disabled",
  );
}

/**
 * Intersects supplied native provenance with the durable OpenClaw cap. A creator-derived default
 * finite cap may retain native authority; an explicit finite cap must disable the opaque surface.
 */
export function constrainCronScheduledNativePolicy(params: {
  scheduledNativePolicy: CronScheduledNativePolicy | undefined;
  toolsAllow: readonly string[] | undefined;
  toolsAllowIsDefault?: boolean;
}): CronScheduledNativePolicy | undefined {
  const normalized = normalizeCronScheduledNativePolicy(params.scheduledNativePolicy);
  if (!normalized) {
    // Missing historical provenance remains conservative even if a legacy row carries the
    // default-cap marker; that marker does not prove whether the creator had native authority.
    return deriveCronScheduledNativePolicy(params.toolsAllow);
  }
  if (!params.toolsAllow) {
    return undefined;
  }
  if (normalized.mode === "disabled") {
    return normalized;
  }
  const capAllowsNative =
    params.toolsAllowIsDefault === true || params.toolsAllow.some((name) => name.trim() === "*");
  return createCronScheduledNativePolicy(capAllowsNative ? "inherit" : "disabled");
}

/** Applies the persisted native ceiling to an otherwise configured agent runtime. */
export function resolveCronScheduledAgentRuntime(
  policy: CronScheduledNativePolicy | undefined,
  configuredRuntime: string | undefined,
): string | undefined {
  return policy?.mode === "disabled" ? "openclaw" : configuredRuntime;
}
