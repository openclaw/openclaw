import { formatErrorMessage } from "../../infra/errors.js";
import type { GatewayRestartDecision } from "../../infra/process-respawn.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import type { GatewayRunSignalRequest } from "./run-loop-request.js";

type Runtime = Pick<typeof import("./lifecycle.runtime.js"), "prepareGatewayRestartHandoffRuntime">;

/** Own code-only warming separately from accepted database work during shutdown. */
export function createGatewayRestartRuntimePreparation(
  runtime: Runtime,
  logger: Pick<SubsystemLogger, "warn">,
) {
  let current: ReturnType<Runtime["prepareGatewayRestartHandoffRuntime"]>;
  let pending: Promise<void> | undefined;
  return {
    get current() {
      return current;
    },
    get pending() {
      return Boolean(current || pending);
    },
    prepare(request: GatewayRunSignalRequest, decision: GatewayRestartDecision) {
      if (
        request.action !== "restart" ||
        decision.mode !== "supervised" ||
        request.restartIntent?.successorOwner
      ) {
        return undefined;
      }
      try {
        current = runtime.prepareGatewayRestartHandoffRuntime();
        return current;
      } catch (error) {
        logger.warn(`restart runtime preparation unavailable: ${formatErrorMessage(error)}`);
        return undefined;
      }
    },
    async settle(operation: Promise<void>, prepared: typeof current): Promise<void> {
      try {
        await operation;
      } finally {
        if (prepared) {
          await this.release(prepared);
        }
      }
    },
    release(prepared = current) {
      if (prepared) {
        if (current === prepared) {
          current = undefined;
        }
        const cleanup = Promise.all([pending, prepared.release()]).then(() => undefined);
        pending = cleanup;
        void cleanup.then(
          () => {
            if (pending === cleanup) {
              pending = undefined;
            }
          },
          () => undefined,
        );
      }
      return pending;
    },
  };
}
