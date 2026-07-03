import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsListResult } from "../../api/types.ts";

export async function loadAgentsList(client: GatewayBrowserClient): Promise<AgentsListResult> {
  return client.request<AgentsListResult>("agents.list", {});
}
