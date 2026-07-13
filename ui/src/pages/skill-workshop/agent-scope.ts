import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiSelectedGlobalAgentId,
} from "../../lib/sessions/session-key.ts";
import type { SkillWorkshopContext, SkillWorkshopState } from "./proposals.ts";

export function skillWorkshopAgentParams(context: SkillWorkshopContext): { agentId: string } {
  const snapshot = context.gateway.snapshot;
  const sessionAgentId = parseAgentSessionKey(snapshot.sessionKey)?.agentId;
  const selectedAgentId = context.agentSelection.state.selectedId;
  return {
    agentId: sessionAgentId
      ? normalizeAgentId(sessionAgentId)
      : selectedAgentId
        ? normalizeAgentId(selectedAgentId)
        : resolveUiSelectedGlobalAgentId(snapshot),
  };
}

export function resolveSkillWorkshopAgentId(context: SkillWorkshopContext): string {
  return skillWorkshopAgentParams(context).agentId;
}

export function loadedSkillWorkshopAgentParams(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
): { agentId: string } {
  return {
    agentId: state.skillWorkshopAgentId ?? skillWorkshopAgentParams(context).agentId,
  };
}
