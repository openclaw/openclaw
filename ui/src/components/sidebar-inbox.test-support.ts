import type { MentionInboxItem } from "../../../packages/gateway-protocol/src/index.js";

export function inboxMention(id: string): MentionInboxItem {
  return {
    id,
    senderProfileId: "profile-riley",
    senderLabel: "Riley",
    sessionKey: "agent:writer:chat:12345678-90ab-cdef-1234-567890abcdef",
    agentId: "writer",
    sessionTitle: "Release notes",
    messageId: `message-${id}`,
    createdAt: 1_780_000_000_000,
    expiresAt: 1_780_003_600_000,
    excerpt: "Can you review the release notes?",
  };
}
