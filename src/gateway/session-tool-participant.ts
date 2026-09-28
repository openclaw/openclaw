import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import {
  getGatewayToolCallerIdentity,
  resolveGatewayPersonalToolParticipant,
} from "../agents/tools/gateway-caller-context.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { AgentRuntimeIdentity } from "./agent-runtime-identity-token.js";
import type { GatewayRequestOptions } from "./server-methods/types.js";

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

/** Expected participant refusals are request policy outcomes, not handler failures. */
export function resolveRuntimeSessionParticipantRequest(
  options: Pick<GatewayRequestOptions, "req" | "client" | "respond">,
): ReturnType<typeof resolveRuntimeSessionParticipant> | null {
  try {
    return resolveRuntimeSessionParticipant(
      options.req.method,
      options.client?.internal?.agentRuntimeIdentity,
    );
  } catch (error) {
    options.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)),
    );
    return null;
  }
}
