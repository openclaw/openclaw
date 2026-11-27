import type { EarlyApplicationGateway } from "./early-gateway.ts";
import type { ApplicationGateway } from "./gateway.ts";
import type { createStartupLifecycle, StartupStep } from "./startup-lifecycle.ts";

export function prepareApplicationGatewayStart(
  gateway: ApplicationGateway,
  earlyGateway: EarlyApplicationGateway | undefined,
  prioritizeSessionsTable: boolean,
  lifecycle: ReturnType<typeof createStartupLifecycle>,
): StartupStep {
  // Fetch the optional scheduler alongside the Sessions view. A failed import falls
  // back to ordinary list ordering so the Gateway can still start.
  const tablePriority = prioritizeSessionsTable
    ? import("../lib/sessions/session-table-priority.ts").then(
        (module) => module.prioritizeInitialSessionsTable,
        () => undefined,
      )
    : undefined;

  return () => {
    lifecycle.addDisposer(() => {
      if (earlyGateway && !earlyGateway.credentials && !gateway.snapshot.client) {
        earlyGateway.transport.client.stop();
      }
      gateway.stop();
    });
    const start = (prioritize?: (client: object) => void) => {
      if (!lifecycle.signal.aborted) {
        gateway.start();
        const client = gateway.snapshot.client;
        if (client) {
          prioritize?.(client);
        }
      }
    };
    return tablePriority ? tablePriority.then(start) : start();
  };
}
