import type { EarlyApplicationGateway } from "./early-gateway.ts";
import type { ApplicationGateway } from "./gateway.ts";
import type { createStartupLifecycle, StartupStep } from "./startup-lifecycle.ts";

async function loadSessionsTablePriority() {
  try {
    const { prioritizeInitialSessionsTable } =
      await import("../lib/sessions/session-table-priority.ts");
    return prioritizeInitialSessionsTable;
  } catch {
    // A failed scheduler fetch falls back to ordinary list ordering.
    return undefined;
  }
}

export function prepareApplicationGatewayStart(
  gateway: ApplicationGateway,
  earlyGateway: EarlyApplicationGateway | undefined,
  prioritizeSessionsTable: boolean,
  lifecycle: ReturnType<typeof createStartupLifecycle>,
): StartupStep {
  const tablePriority = prioritizeSessionsTable ? loadSessionsTablePriority() : undefined;

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
