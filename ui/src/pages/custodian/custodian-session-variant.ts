import type { ApplicationContext } from "../../app/context.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";

export type CustodianConfiguredInferenceState = "unresolved" | "required" | "utility" | "ready";

export function configuredCustodianInference(
  context: ApplicationContext,
): CustodianConfiguredInferenceState {
  const agentsList = context.agents.state.agentsList;
  if (context.gateway.snapshot.phase !== "connected" || !agentsList) {
    return "unresolved";
  }
  const selectedId = normalizeAgentId(
    context.gateway.snapshot.assistantAgentId ?? agentsList.defaultId ?? "",
  );
  const selectedAgent = agentsList.agents.find(
    (agent) => normalizeAgentId(agent.id) === selectedId,
  );
  if (!selectedAgent) {
    return "unresolved";
  }
  return selectedAgent.model?.primary?.trim()
    ? "ready"
    : selectedAgent.utilityModel?.trim()
      ? "utility"
      : "required";
}
