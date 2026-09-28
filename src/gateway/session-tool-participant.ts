import {
  getGatewayToolCallerIdentity,
  resolveGatewayPersonalToolParticipant,
} from "../agents/tools/gateway-caller-context.js";
import type { AgentRuntimeIdentity } from "./agent-runtime-identity-token.js";

/** Runtime tokens identify a turn, but cannot transport a named-person selection. */
export function resolveRuntimeSessionParticipant(
  method: string,
  runtimeIdentity: AgentRuntimeIdentity | undefined,
) {
  if (
    getGatewayToolCallerIdentity() ||
    !(
      method.startsWith("sessions.") ||
      method === "chat.history" ||
      method === "agent" ||
      method === "agent.wait"
    )
  ) {
    return undefined;
  }
  return resolveGatewayPersonalToolParticipant(runtimeIdentity);
}
