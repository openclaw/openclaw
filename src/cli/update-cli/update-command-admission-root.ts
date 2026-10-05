import type { ManagedServicePackageUpdatePlan } from "./update-command-service-context-types.js";

/** Admission follows the managed service root before a redirect or discovered install. */
export function resolveUpdateCommandAdmissionRoot(prepared: {
  servicePlan?: ManagedServicePackageUpdatePlan;
  discoveredRoot: string;
}): string {
  return (
    prepared.servicePlan?.serviceRoot ??
    prepared.servicePlan?.rootRedirect?.root ??
    prepared.discoveredRoot
  );
}
