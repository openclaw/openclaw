/** Storage adapters supply ancestry from their admitted transcript. */
export function resolveTranscriptAppendParent(params: {
  readTailId(): string | null;
  parentId: string | null | undefined;
  appendIntent?: "active-branch";
  isAncestor(leafId: string, candidateId: string | null): boolean;
}): string | null {
  if (params.parentId !== undefined && params.appendIntent !== "active-branch") {
    return params.parentId;
  }
  const tailId = params.readTailId();
  if (params.parentId === undefined) {
    return tailId;
  }
  if (tailId === params.parentId || tailId === null) {
    return params.parentId;
  }
  return params.isAncestor(tailId, params.parentId) ? tailId : params.parentId;
}

export const PREPARED_ASSISTANT_MAX_NEWER_MESSAGES = 256;
export const PREPARED_ASSISTANT_MAX_NEWER_BYTES = 1024 * 1024;
export const PREPARED_ASSISTANT_MAX_ANCESTORS = 4096;

export type PreparedAssistantMessageFacts = {
  event_id: string;
  message_role: unknown;
  context_free_command: number | null;
  human_addressed: number | null;
  provenance_kind: unknown;
  provenance_source_channel: unknown;
};

/**
 * Only the admitted user, context-free commands, messages addressed to other
 * people, and final Talk records are transparent.
 */
export function preparedAssistantMessagesPreserveTurn<T extends PreparedAssistantMessageFacts>(
  messages: readonly T[],
  admittedUserId: string | undefined,
  isAdmittedQuestionAnswer: (message: T) => boolean,
): boolean {
  return messages.every((message) => {
    if (
      message.message_role !== "user" ||
      message.event_id === admittedUserId ||
      message.context_free_command === 1 ||
      message.human_addressed === 1
    ) {
      return true;
    }
    if (
      message.provenance_kind === "realtime_voice" &&
      message.provenance_source_channel === "talk"
    ) {
      return true;
    }
    return isAdmittedQuestionAnswer(message);
  });
}
