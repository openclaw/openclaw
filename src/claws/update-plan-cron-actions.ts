import { CLAW_CRON_REF_SCHEMA_VERSION, type PersistedClawCronRef } from "./cron.js";
import { digestClawValue as digest } from "./digest.js";
import type { ClawManifest } from "./types.js";
import {
  resourceCapabilityChange,
  type ClawUpdateCapabilityChange,
} from "./update-capability-changes.js";
import type { ClawUpdateAction } from "./update-plan-types.js";

export function pushClawCronUpdateActions(params: {
  agentId: string;
  currentCronJobs: PersistedClawCronRef[];
  targetCronJobs: ClawManifest["cronJobs"];
  actions: ClawUpdateAction[];
  capabilityChanges: ClawUpdateCapabilityChange[];
}): void {
  const { agentId, currentCronJobs, targetCronJobs, actions, capabilityChanges } = params;
  const currentCron = new Map(currentCronJobs.map((cron) => [cron.manifestId, cron] as const));
  for (const target of targetCronJobs) {
    const current = currentCron.get(target.id);
    const desiredDigest = digest(target);
    const unsupported = current && current.schemaVersion !== CLAW_CRON_REF_SCHEMA_VERSION;
    const unresolved =
      current && (unsupported || current.status !== "complete" || !current.schedulerJobId);
    const action = !current
      ? "add"
      : unresolved
        ? "manual"
        : digest(current.job) === desiredDigest
          ? "unchanged"
          : "change";
    actions.push({
      kind: "cronJob",
      id: target.id,
      action,
      target: current?.schedulerJobId ?? `claw:${agentId}:${target.id}`,
      blocked: action === "manual",
      reason:
        action === "manual"
          ? unsupported
            ? "Cron provenance version is unsupported."
            : "Cron ownership is unresolved and must be reconciled with the gateway."
          : action === "unchanged"
            ? "Recorded cron declaration already matches the target manifest."
            : `Target manifest ${action === "add" ? "adds" : "changes"} this cron declaration.`,
      ...(current ? { currentDigest: digest(current.job) } : {}),
      desiredDigest,
    });
    const capabilityChange = resourceCapabilityChange({
      kind: "cronJob",
      id: target.id,
      action,
      current: current?.job,
      desired: target,
    });
    if (capabilityChange) {
      capabilityChanges.push(capabilityChange);
    }
  }
  for (const current of currentCronJobs) {
    if (targetCronJobs.some((cron) => cron.id === current.manifestId)) {
      continue;
    }
    const manual =
      current.schemaVersion !== CLAW_CRON_REF_SCHEMA_VERSION ||
      current.status !== "complete" ||
      !current.schedulerJobId;
    const action = manual ? "manual" : "remove";
    actions.push({
      kind: "cronJob",
      id: current.manifestId,
      action,
      target: current.schedulerJobId ?? current.declarationKey,
      blocked: manual,
      reason: manual
        ? current.schemaVersion !== CLAW_CRON_REF_SCHEMA_VERSION
          ? "Target removes this cron declaration, but its provenance version is unsupported."
          : "Target removes this cron declaration, but scheduler ownership is unresolved."
        : "Target manifest removes this owned cron declaration.",
      currentDigest: digest(current.job),
    });
    const capabilityChange = resourceCapabilityChange({
      kind: "cronJob",
      id: current.manifestId,
      action,
      current: current.job,
    });
    if (capabilityChange) {
      capabilityChanges.push(capabilityChange);
    }
  }
}
