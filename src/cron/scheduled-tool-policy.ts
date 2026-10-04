import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeOptionalAccountId } from "../routing/account-id.js";
import { snapshotOwnCronRecord } from "./own-record.js";

/** Closed, server-authored origin of an account-scoped scheduled task. */
export type CronScheduledToolCallerOrigin =
  | { kind: "external"; channel: string }
  | { kind: "local" }
  | { kind: "unknown" };

/** Invalid, legacy, or incomplete origin facts stay explicitly unknown. */
export function normalizeCronScheduledToolCallerOrigin(
  value: unknown,
): CronScheduledToolCallerOrigin {
  const input = isRecord(value) ? snapshotOwnCronRecord(value) : undefined;
  if (!input || typeof input.kind !== "string") {
    return { kind: "unknown" };
  }
  const keys = Object.keys(input);
  if (input.kind === "local" && keys.every((key) => key === "kind")) {
    return { kind: "local" };
  }
  if (input.kind === "unknown" && keys.every((key) => key === "kind")) {
    return { kind: "unknown" };
  }
  const channel = normalizeOptionalString(
    input.kind === "external" && typeof input.channel === "string" ? input.channel : undefined,
  )?.toLowerCase();
  return channel && keys.every((key) => key === "kind" || key === "channel")
    ? { kind: "external", channel }
    : { kind: "unknown" };
}

/**
 * Legacy creator execution target retained in the persisted envelope for rollback.
 * Current scheduled execution uses the owning agent's current policy.
 */
export type CronToolsAllowExecTarget = {
  version: 1;
  host: "gateway";
  /** Mandatory approval floor inherited from the captured creator surface. */
  ask?: "always";
};

/** Persisted proof that this job was created with an exact exec restriction. */
export type CronToolsAllowExecTargetRequirement =
  | {
      version: 1;
      target: CronToolsAllowExecTarget;
      grantIndex: number;
      recoveryRequired?: never;
    }
  | {
      version: 1;
      target?: never;
      recoveryRequired: true;
    };

/** Retains only recognized restrictions; future fields remain reader-safe. */
export function normalizeCronToolsAllowExecTarget(
  value: unknown,
): CronToolsAllowExecTarget | undefined {
  const input = isRecord(value) ? snapshotOwnCronRecord(value) : undefined;
  return input?.version === 1 && input.host === "gateway"
    ? {
        version: 1,
        host: "gateway",
        ...(input.ask === "always" ? { ask: "always" } : {}),
      }
    : undefined;
}

/** Invalid requirement markers remain durable fail-closed recovery state. */
export function normalizeCronToolsAllowExecTargetRequirement(
  value: unknown,
): CronToolsAllowExecTargetRequirement | undefined {
  if (value === undefined) {
    return undefined;
  }
  const input = isRecord(value) ? snapshotOwnCronRecord(value) : undefined;
  if (!input || input.version !== 1 || input.recoveryRequired === true) {
    return { version: 1, recoveryRequired: true };
  }
  const rawTarget = isRecord(input.target) ? snapshotOwnCronRecord(input.target) : undefined;
  const target =
    rawTarget &&
    rawTarget.version === 1 &&
    rawTarget.host === "gateway" &&
    (rawTarget.ask === undefined || rawTarget.ask === "always")
      ? {
          version: 1 as const,
          host: "gateway" as const,
          ...(rawTarget.ask === "always" ? { ask: "always" as const } : {}),
        }
      : undefined;
  const grantIndex = input.grantIndex;
  return target && typeof grantIndex === "number" && Number.isInteger(grantIndex) && grantIndex >= 0
    ? { version: 1, target, grantIndex }
    : { version: 1, recoveryRequired: true };
}

function resolveMatchingCronExecTarget(params: {
  requirement?: unknown;
  execTarget?: unknown;
}): Extract<CronToolsAllowExecTargetRequirement, { target: CronToolsAllowExecTarget }> | undefined {
  const requirement = normalizeCronToolsAllowExecTargetRequirement(params.requirement);
  const execTarget = normalizeCronToolsAllowExecTarget(params.execTarget);
  return requirement &&
    "target" in requirement &&
    requirement.target !== undefined &&
    execTarget?.host === requirement.target.host &&
    execTarget.ask === requirement.target.ask
    ? requirement
    : undefined;
}

/** Removes a pinned exec grant from the generic persisted cap; the private envelope owns it. */
export function stripCronPinnedExecGrant(params: {
  toolsAllow?: readonly string[];
  requirement?: unknown;
}): string[] | undefined {
  if (!params.toolsAllow) {
    return undefined;
  }
  return normalizeCronToolsAllowExecTargetRequirement(params.requirement)
    ? params.toolsAllow.filter((tool) => tool !== "exec")
    : [...params.toolsAllow];
}

/** Rehydrates canonical exec only after the persisted grant and restriction agree. */
export function restoreCronPinnedExecGrant(params: {
  toolsAllow?: readonly string[];
  requirement?: unknown;
  execTarget?: unknown;
}): string[] | undefined {
  if (!params.toolsAllow) {
    return undefined;
  }
  const requirement = resolveMatchingCronExecTarget(params);
  if (!requirement || params.toolsAllow.includes("exec") || params.toolsAllow.includes("*")) {
    return [...params.toolsAllow];
  }
  const restored = [...params.toolsAllow];
  restored.splice(Math.min(requirement.grantIndex, restored.length), 0, "exec");
  return restored;
}

/** Server-authored owner context; execution still resolves the agent's current policy. */
export type CronScheduledToolPolicy =
  | {
      version: 1;
      mode: "trusted";
      ownerSessionKey?: never;
      ownerAccountId?: never;
    }
  | {
      version: 1;
      mode: "account";
      ownerSessionKey: string;
      ownerAccountId: string;
    };

/** Creates provenance for an authenticated operator or trusted in-process caller. */
export function createTrustedCronScheduledToolPolicy(): CronScheduledToolPolicy {
  return { version: 1, mode: "trusted" };
}

/** Creates requester-scoped provenance from an authenticated account identity. */
export function createAccountCronScheduledToolPolicy(params: {
  ownerSessionKey: string;
  ownerAccountId: string;
}): CronScheduledToolPolicy | undefined {
  const ownerSessionKey = normalizeOptionalString(params.ownerSessionKey);
  const ownerAccountId = normalizeOptionalAccountId(params.ownerAccountId);
  if (!ownerSessionKey || !ownerAccountId) {
    return undefined;
  }
  return {
    version: 1,
    mode: "account",
    ownerSessionKey,
    ownerAccountId,
  };
}

/** Accepts only the current closed provenance shape; unknown versions fail closed. */
export function normalizeCronScheduledToolPolicy(
  value: unknown,
): CronScheduledToolPolicy | undefined {
  const input = isRecord(value) ? snapshotOwnCronRecord(value) : undefined;
  if (!input || input.version !== 1) {
    return undefined;
  }
  if (input.mode === "trusted") {
    return Object.keys(input).every((key) => key === "version" || key === "mode")
      ? createTrustedCronScheduledToolPolicy()
      : undefined;
  }
  if (input.mode !== "account") {
    return undefined;
  }
  const policy = createAccountCronScheduledToolPolicy({
    ownerSessionKey: typeof input.ownerSessionKey === "string" ? input.ownerSessionKey : "",
    ownerAccountId: typeof input.ownerAccountId === "string" ? input.ownerAccountId : "",
  });
  if (!policy) {
    return undefined;
  }
  return Object.keys(input).every(
    (key) =>
      key === "version" || key === "mode" || key === "ownerSessionKey" || key === "ownerAccountId",
  )
    ? policy
    : undefined;
}

/** Resolves trusted provenance only when it is consistent with the persisted job owner. */
export function resolveCronScheduledToolPolicy(params: {
  scheduledToolPolicy?: unknown;
  owner?: { sessionKey?: string; accountId?: string };
}): CronScheduledToolPolicy | undefined {
  const policy = normalizeCronScheduledToolPolicy(params.scheduledToolPolicy);
  if (!policy || policy.mode === "trusted") {
    return policy;
  }
  const ownerSessionKey = normalizeOptionalString(params.owner?.sessionKey);
  const ownerAccountId = normalizeOptionalAccountId(params.owner?.accountId);
  return ownerSessionKey === policy.ownerSessionKey && ownerAccountId === policy.ownerAccountId
    ? policy
    : undefined;
}
