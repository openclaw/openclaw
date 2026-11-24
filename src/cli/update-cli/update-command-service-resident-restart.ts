import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { GatewayMaintenanceResidentChangedError } from "../../daemon/service-inspection-error.js";
import type { GatewayServiceState } from "../../daemon/service-types.js";
import { GatewayServiceUpdateOwnershipError } from "./update-command-service-plan.js";

const PROCESS_CHANGED = "service-process-changed";

/** The native stop acts on the service; refuse when it no longer runs the drained process. */
export function assertGatewayServiceProcessUnchanged(
  drained: GatewayServiceState,
  current: GatewayServiceState,
): void {
  if (current.runtime?.pid !== drained.runtime?.pid) {
    throw new GatewayServiceUpdateOwnershipError(
      "Gateway process changed during maintenance drain; inspect its service before retrying.",
      undefined,
      undefined,
      PROCESS_CHANGED,
    );
  }
}

/**
 * Drain the inspected Gateway process, then stop its service.
 *
 * `--no-restart` replaces the package under a running Gateway, whose installation
 * check then restarts it, possibly while this stop is in flight. That is the one
 * process change accepted here, and only on the exiting Gateway's own record of it:
 * the service is then inspected once more and its current process is drained and
 * stopped within the same budget. Without that record the change stays refused.
 */
export async function drainGatewayServiceBeforeStop(params: {
  state: GatewayServiceState;
  timeoutMs?: number;
  assertCurrent: () => void;
  warn: (message: string) => void;
  stop: () => Promise<void>;
  /** Reads the service again with its ownership, definition and ancestry rechecked. */
  reinspect: () => Promise<GatewayServiceState>;
}): Promise<void> {
  const { withGatewayMaintenanceDrain } = await import("./update-command-service-drain.js");
  const startedAt = performance.now();
  const drain = (state: GatewayServiceState) =>
    withGatewayMaintenanceDrain(
      {
        state,
        timeoutMs:
          params.timeoutMs === undefined
            ? undefined
            : Math.max(1, params.timeoutMs - (performance.now() - startedAt)),
        assertCurrent: params.assertCurrent,
        warn: params.warn,
      },
      params.stop,
    );
  try {
    await drain(params.state);
    return;
  } catch (error) {
    // Both refusals are raised before the native stop has any effect.
    const pid = params.state.runtime?.pid;
    if (
      pid === undefined ||
      !(
        error instanceof GatewayMaintenanceResidentChangedError ||
        (error instanceof GatewayServiceUpdateOwnershipError &&
          error.failureFacts.some(({ code }) => code === PROCESS_CHANGED))
      )
    ) {
      throw error;
    }
    const { didGatewayExitForReplacedInstallation } =
      await import("../../infra/gateway-boot-lifecycle.js");
    const exitedForReplacement = await didGatewayExitForReplacedInstallation(
      pid,
      params.state.env,
    ).catch((cause: unknown) => {
      params.warn(
        `WARNING: The Gateway process changed during this stop and its shutdown record could not be read (${coerceErrorMessage(cause)}); the change is refused.`,
      );
      return false;
    });
    params.assertCurrent();
    if (!exitedForReplacement) {
      throw error;
    }
  }
  const restarted = await params.reinspect();
  params.warn(
    "WARNING: The running Gateway restarted itself for the replaced installation during this stop; its service was inspected again and the restarted process is drained and stopped instead.",
  );
  await drain(restarted);
}
