import { solidContent } from "../lit/solid-content.tsx";
import { AgentAvatarFace } from "./agent-avatar-face.tsx";

export function renderAgentAvatarFace(agentId: string) {
  return solidContent(AgentAvatarFace, { agentId });
}
