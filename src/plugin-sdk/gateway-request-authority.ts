import { getPluginRuntimeExecutionFrame } from "../plugins/runtime/execution-frame.js";
import type { GatewayRequestAuthorityV1 } from "../plugins/runtime/gateway-request-scope.types.js";

export type { GatewayRequestAuthorityV1 };

/** Read the Gateway's authority for this HTTP or RPC handler, if admitted. */
export function getGatewayRequestAuthorityV1(): GatewayRequestAuthorityV1 | undefined {
  const scope = getPluginRuntimeExecutionFrame()?.gatewayScope;
  return scope?.readRequestAuthority?.(scope.client);
}
