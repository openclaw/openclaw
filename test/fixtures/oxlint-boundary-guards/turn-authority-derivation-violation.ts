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

// Forms that can only narrow a passed-along bit are not producers; defaults to owner are.
export function narrowOwner(input: { senderIsOwner?: boolean }, scoped: boolean) {
  return [
    { senderIsOwner: input.senderIsOwner === true },
    { senderIsOwner: scoped ? input.senderIsOwner : false },
    { senderIsOwner: input.senderIsOwner && scoped },
    {
      get senderIsOwner() {
        return input.senderIsOwner;
      },
    },
    { senderIsOwner: input.senderIsOwner ?? true },
    { senderIsOwner: input.senderIsOwner !== false },
    // A function value is truthy whatever it returns; only a getter is read as its value.
    {
      senderIsOwner() {
        return false;
      },
    },
    {
      senderIsOwner: function () {
        return false;
      },
    },
  ];
}
