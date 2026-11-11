import type { GatewayDrainReason } from "../../process/gateway-work-admission.js";
import type { createGatewayHostLifecycle } from "./host-lifecycle.js";
import { formatShutdownReason } from "./run-loop-shutdown-format.js";
import type { createGatewayRunSignals } from "./run-loop-signals.js";

type Request = Parameters<typeof createGatewayRunSignals>[0]["request"];
type Host = ReturnType<typeof createGatewayHostLifecycle>;
type ProcessOwner = Parameters<typeof createGatewayHostLifecycle>[0]["processOwner"];

/** Commit admission while the external supervisor still owns process termination. */
export function createExternalStopHandoff(
  initial: {
    lifecycleRuntime: { markGatewayDraining: (reason: GatewayDrainReason) => void };
    supervisorMode: ProcessOwner["supervisor"];
  },
  params: { ownsProcessLifecycle?: boolean },
  logger: { info: (message: string) => void },
) {
  let fenced = false;
  return {
    wrap(request: Request): Request {
      return (action, signal, restartReason, restartIntent, hostedStop, context) => {
        if (fenced && action !== "stop") {
          if (signal === "SIGTERM") {
            // Discard a stale restart intent when the supervisor terminates us.
            request("stop", signal, undefined, undefined, hostedStop, context);
          } else {
            logger.info("external stop is committed; waiting for the supervisor stop signal");
          }
          return;
        }
        request(action, signal, restartReason, restartIntent, hostedStop, context);
      };
    },
    hostCallbacks(request: Request, getHost: () => Host) {
      return {
        processOwner: {
          ownsProcessLifecycle: params.ownsProcessLifecycle === true,
          supervisor: initial.supervisorMode,
        },
        acceptStop: () => request("stop", "hosted Gateway stop", undefined, undefined, getHost()),
        commitExternalStop: () => request("stop", "SIGTERM"),
        commitExternalStopFence: () => {
          fenced = true;
          initial.lifecycleRuntime.markGatewayDraining(
            formatShutdownReason({ action: "stop", signal: "SIGTERM" }),
          );
        },
      };
    },
  };
}
