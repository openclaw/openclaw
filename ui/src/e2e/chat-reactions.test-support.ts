import type { MessageReactionSummary } from "@openclaw/gateway-protocol";
import type { ControlUiMockGatewayScenario } from "../test-helpers/control-ui-e2e.ts";

export const reactionSessionKey = "agent:main:main";
export const reactionSessionId = "reaction-session";
export const peerMessageId = "riley-prompt";
export const ownMessageId = "avery-prompt";
export const finalMessageId = "assistant-final";
export const currentPerson = { id: "profile-avery", label: "Avery" };
export const people = Array.from({ length: 24 }, (_, index) => ({
  id: `profile-person-${index}`,
  label: `Person ${index + 1}`,
}));

export function peerReactions(): MessageReactionSummary[] {
  return ["👍", "🎉", "👀", "❤️", "🚀", "😂", "🔥", "👏", "🦞", "✅"].map((emoji, index) => ({
    emoji,
    count: index === 0 ? people.length : 1,
    identities: index === 0 ? people : [people[index]!],
  }));
}

export function reactionScenario(): ControlUiMockGatewayScenario {
  return {
    sessionKey: reactionSessionKey,
    presenceUsers: [
      {
        self: true,
        id: currentPerson.id,
        identity: { type: "profile", id: currentPerson.id },
        name: currentPerson.label,
      },
    ],
    sessions: [
      {
        key: reactionSessionKey,
        sessionId: reactionSessionId,
        visibility: "shared",
        sharingRole: "owner",
      },
    ],
    methodResponses: {
      "session.members.listEvidence": {
        sessionKey: reactionSessionKey,
        owner: { type: "human", ...currentPerson },
        members: [],
        identities: [],
        role: "owner",
        allowedVisibilities: ["shared", "read-only", "suggest", "draft"],
      },
    },
    historyMessages: [
      {
        role: "user",
        content: [{ type: "text", text: "Keep the launch checklist short." }],
        __openclaw: { id: peerMessageId, seq: 1, senderName: "Riley", senderId: "profile-riley" },
      },
      {
        role: "user",
        content: [{ type: "text", text: "Thursday works." }],
        __openclaw: {
          id: ownMessageId,
          seq: 2,
          senderName: currentPerson.label,
          senderId: currentPerson.id,
        },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Reviewing the checklist." }],
        __openclaw: { id: "assistant-intermediate", seq: 3 },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "The launch checklist is ready." }],
        __openclaw: { id: finalMessageId, seq: 4 },
      },
    ],
    sessionReactions: {
      [reactionSessionKey]: {
        [peerMessageId]: peerReactions(),
        [ownMessageId]: [{ emoji: "👀", count: 1, identities: [currentPerson] }],
        [finalMessageId]: [{ emoji: "✅", count: 1, identities: [people[0]!] }],
      },
    },
  };
}
