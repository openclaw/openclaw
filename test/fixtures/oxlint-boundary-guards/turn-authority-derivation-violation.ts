import type { NormalizedChatSendRequest } from "../../../src/gateway/server-methods/chat-send-request.js";

// A planted divergence: the same person gets a different answer by how the turn started.
export function plantDivergence(
  request: NormalizedChatSendRequest,
  authority: { scopes: string[]; grant: { owner: boolean } },
  input: { senderIsOwner?: boolean; isAdmin?: boolean },
) {
  const passed = { senderIsOwner: authority.grant.owner };
  const { senderIsOwner: passedAlong } = input;
  const { senderIsOwner = true } = input;
  const { isAdmin: requesterOwner = true } = input;
  const skills = !request.reconnectResumeRequested && request.turnKind === "main";
  return { passed, passedAlong, senderIsOwner, requesterOwner, skills };
}

export function mintOwner(authority: { scopes: string[] }) {
  return { senderIsOwner: authority.scopes.includes("operator.admin") };
}
