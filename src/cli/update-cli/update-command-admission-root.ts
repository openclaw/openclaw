import type { prepareUpdateCommand } from "./update-command-run.js";

/** Admission follows the managed service root before a redirect or discovered install. */
export function resolveUpdateCommandAdmissionRoot(
  prepared: Pick<
    Awaited<ReturnType<typeof prepareUpdateCommand>>,
    "servicePlan" | "discoveredRoot"
  >,
): string {
  return (
    prepared.servicePlan?.serviceRoot ??
    prepared.servicePlan?.rootRedirect?.root ??
    prepared.discoveredRoot
  );
}
