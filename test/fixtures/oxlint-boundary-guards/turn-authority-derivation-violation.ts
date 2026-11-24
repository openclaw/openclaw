import type { NormalizedChatSendRequest } from "../../../src/gateway/server-methods/chat-send-request.js";

// A planted divergence: the same person gets a different answer by how the turn started.
export function plantDivergence(
  request: NormalizedChatSendRequest,
  authority: { scopes: string[]; grant: { owner: boolean } },
) {
  const passed = { senderIsOwner: authority.grant.owner };
  const skills = !request.reconnectResumeRequested && request.turnKind === "main";
  return { ...passed, skills, senderIsOwner: authority.scopes.includes("operator.admin") };
}
