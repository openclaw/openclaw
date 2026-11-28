import { MAX_HUMAN_MENTIONS } from "../../packages/gateway-protocol/src/index.js";

export type MentionCommittedInput = {
  sourceId: string;
  committedSource: { generation: string; sequence: number; timestamp: number };
  sessionKey: string;
  agentId?: string;
  sessionId: string;
  messageId: string;
  senderProfileId: string;
  recipientProfileIds: readonly string[];
  excerpt?: string;
};

export function hasValidMentionReferences(input: MentionCommittedInput): boolean {
  const references = [
    input.sourceId,
    input.sessionId,
    input.messageId,
    input.senderProfileId,
    ...input.recipientProfileIds,
  ];
  return (
    input.recipientProfileIds.length <= MAX_HUMAN_MENTIONS &&
    input.sessionKey.length <= 512 &&
    references.every((value) => Boolean(value) && value.length <= 256)
  );
}
