import { prioritizeInitialSessionsTable } from "../lib/sessions/session-table-priority.ts";
import type { EarlyApplicationGateway } from "./early-gateway.ts";
import type { ApplicationGateway } from "./gateway.ts";

export function startApplicationGatewayConnection(
  gateway: ApplicationGateway,
  earlyGateway: EarlyApplicationGateway | undefined,
  prioritizeSessionsTable: boolean,
): () => void {
  gateway.start();
  const client = prioritizeSessionsTable ? gateway.snapshot.client : null;
  if (client) {
    prioritizeInitialSessionsTable(client);
  }
  return () => {
    if (earlyGateway && !earlyGateway.credentials && !gateway.snapshot.client) {
      earlyGateway.transport.client.stop();
    }
    gateway.stop();
  };
}
