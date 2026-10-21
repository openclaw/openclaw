import type { AgentsListResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

/** Session bootstrap exposes intent only; inventory and execution retain their own grants. */
export async function readSessionPlacementPolicy(client: Pick<GatewayBrowserClient, "request">) {
  const result = await client.request<AgentsListResult>("agents.list", {
    includeSessionPlacement: true,
  });
  if (!result.sessionPlacement) {
    throw new Error("Session placement policy is unavailable");
  }
  return result.sessionPlacement;
}
