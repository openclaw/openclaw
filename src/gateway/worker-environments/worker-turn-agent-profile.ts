import { resolveAgentProfile } from "../../agents/agent-profiles.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";

/** Resolves the Agent Profile that the Gateway selected for a worker turn. */
export function resolveWorkerTurnAgentProfile(params: {
  turn: Pick<SessionPlacementTurnParams, "config" | "sessionKey" | "agentId">;
}) {
  return resolveAgentProfile({
    config: params.turn.config,
    agentId: params.turn.agentId,
    sessionKey: params.turn.sessionKey,
  });
}
