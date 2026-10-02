import { CLAW_CRON_REF_SCHEMA_VERSION, type PersistedClawCronRef } from "./cron.js";
import type { ClawRemovePlanAction } from "./lifecycle-remove-contract.js";

export function clawCronRemovalIssue(cron: PersistedClawCronRef): string | undefined {
  if (cron.schemaVersion !== CLAW_CRON_REF_SCHEMA_VERSION) {
    return "Cron provenance version is unsupported.";
  }
  if (cron.status !== "removed" && (cron.status !== "complete" || !cron.schedulerJobId)) {
    return `Cron ownership state is ${cron.status}.`;
  }
  return undefined;
}

export function planClawCronRemovalAction(cron: PersistedClawCronRef): ClawRemovePlanAction {
  const reason = clawCronRemovalIssue(cron);
  return {
    kind: "cronJob",
    id: cron.manifestId,
    action: reason ? "retain" : "remove",
    target: cron.schedulerJobId ?? cron.declarationKey,
    blocked: Boolean(reason),
    details: {
      expectedStatus: cron.status,
      declarationKey: cron.declarationKey,
      schedulerJobId: cron.schedulerJobId,
      job: cron.job,
    },
    ...(reason ? { reason } : {}),
  };
}
