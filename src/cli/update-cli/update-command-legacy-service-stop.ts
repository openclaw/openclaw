import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import type { PreManagedServiceStop } from "./update-command-service-context-types.js";

/**
 * A legacy updater (through 2026.9.5) inspects the managed Gateway service with
 * its own manager adapter before handing finalization to this candidate. When
 * that inspection is unavailable it transfers an unstopped, still-running
 * service, so the candidate's Doctor cannot enter maintenance: the predecessor
 * Gateway keeps gateway-lifecycle and, being supervised, never releases it on
 * its own. The candidate must inspect and stop that service itself.
 */
export function needsCandidateManagedServiceStop(params: {
  preManagedServiceStop: PreManagedServiceStop | undefined;
  shouldRestart: boolean;
  mode: UpdateRunResult["mode"];
  windowsTaskAutoStartSuspended?: boolean;
}): boolean {
  const transferred = params.preManagedServiceStop;
  return (
    params.shouldRestart &&
    params.mode !== "unknown" &&
    transferred?.serviceUpdateVerdict?.kind === "unavailable" &&
    !transferred.stopped &&
    !transferred.inspected &&
    params.windowsTaskAutoStartSuspended !== true
  );
}
