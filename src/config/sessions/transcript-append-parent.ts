/** Storage adapters supply ancestry from their admitted transcript. */
export function resolveTranscriptAppendParent(params: {
  tailId: string | null;
  parentId: string | null | undefined;
  appendIntent?: "active-branch";
  isAncestor(leafId: string, candidateId: string | null): boolean;
}): string | null {
  if (params.parentId === undefined) {
    return params.tailId;
  }
  if (
    params.appendIntent !== "active-branch" ||
    params.tailId === params.parentId ||
    params.tailId === null
  ) {
    return params.parentId;
  }
  return params.isAncestor(params.tailId, params.parentId) ? params.tailId : params.parentId;
}

export const PREPARED_ASSISTANT_MAX_NEWER_MESSAGES = 256;
export const PREPARED_ASSISTANT_MAX_NEWER_BYTES = 1024 * 1024;
export const PREPARED_ASSISTANT_MAX_ANCESTORS = 4096;

export type PreparedAssistantMessageFacts = {
  event_id: string;
  message_role: unknown;
  context_free_command: number | null;
  provenance_kind: unknown;
  provenance_source_channel: unknown;
};

/** Only the admitted user, context-free commands, and final Talk records are transparent. */
export function preparedAssistantMessagesPreserveTurn<T extends PreparedAssistantMessageFacts>(
  messages: readonly T[],
  admittedUserId: string | undefined,
  isAdmittedQuestionAnswer: (message: T) => boolean,
): boolean {
  return messages.every((message) => {
    if (
      message.message_role !== "user" ||
      message.event_id === admittedUserId ||
      message.context_free_command === 1
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
