import { GATEWAY_CLIENT_MODES } from "../../../packages/gateway-protocol/src/client-info.js";
import type { AgentTurnPrincipal } from "./types.js";

/** Determines whether the connection has server-owned internal handoff authority. */
export function canUseInternalAgentHandoff(
  mode: string | undefined,
  evidence?: Pick<
    NonNullable<AgentTurnPrincipal["internal"]>,
    "syntheticClient" | "localBackendClient"
  >,
): boolean {
  return (
    mode === GATEWAY_CLIENT_MODES.BACKEND &&
    (evidence?.syntheticClient === true || evidence?.localBackendClient === true)
  );
}
