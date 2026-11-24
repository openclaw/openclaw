import type { NormalizedChatSendRequest } from "../../../src/gateway/server-methods/chat-send-request.js";

// A planted divergence: the same person gets a different answer by how the turn started.
export function plantDivergence(
  request: NormalizedChatSendRequest,
  authority: { scopes: string[]; grant: { owner: boolean } },
  input: { senderIsOwner?: boolean },
) {
  const passed = { senderIsOwner: authority.grant.owner };
  const { senderIsOwner: passedAlong } = input;
  const { senderIsOwner = true } = input;
  const skills = !request.reconnectResumeRequested && request.turnKind === "main";
  return { passed, passedAlong, senderIsOwner, skills, owner: authority.scopes.length > 0 };
}

export function mintOwner(authority: { scopes: string[] }) {
  return { senderIsOwner: authority.scopes.includes("operator.admin") };
}
