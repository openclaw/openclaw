import { getRuntimeConfig } from "../config/io.js";
import { resolveCronJobBoundSessionKeys } from "../cron/job-session-bindings.js";
import type { CronEvent } from "../cron/types.js";
import type { getChildLogger } from "../logging.js";
import type { GatewayBroadcastFn } from "./server-broadcast-types.js";
import type { GatewayCronServiceContract } from "./server-cron-contract.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";

export function createGatewayCronPublisher(params: {
  broadcast: GatewayBroadcastFn;
  getCron: () => Pick<GatewayCronServiceContract, "getJob" | "getDefaultAgentId">;
  resolveGatewayContext?: () => GatewayRequestContext | undefined;
  logger: Pick<ReturnType<typeof getChildLogger>, "warn">;
}) {
  return (evt: CronEvent) => {
    // Retargeting can remove a reader from the detailed event's new audience.
    params.broadcast("cron.inventory.changed", undefined, { dropIfSlow: true });
    const cron = params.getCron();
    const job = evt.job ?? cron.getJob(evt.jobId);
    if (!job) {
      return;
    }
    const boundKeys = resolveCronJobBoundSessionKeys(job, {
      cfg: getRuntimeConfig(),
      defaultAgentId: cron.getDefaultAgentId(),
    });
    // Badges consume refreshed session rows after their projection has settled.
    for (const sessionKey of boundKeys) {
      const context = params.resolveGatewayContext?.();
      const projection = getSessionRowProjection(context);
      const publish = () =>
        params.broadcast(
          "sessions.changed",
          { sessionKey, reason: "cron-binding", ts: Date.now() },
          { dropIfSlow: true },
        );
      if (projection) {
        void (async () => {
          do {
            await projection.ensureMaterialized();
          } while (projection.needsMaterialization);
          if (params.resolveGatewayContext?.() === context) {
            publish();
          }
        })().catch((error: unknown) =>
          params.logger.warn({ error }, "Cron session publication failed"),
        );
      } else {
        publish();
      }
    }
  };
}
