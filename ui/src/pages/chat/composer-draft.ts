import type {
  ChatAttachment,
  ChatGoalDraftMode,
  ChatReplyTarget,
  HumanMention,
} from "../../lib/chat/chat-types.ts";

/** Preserve meaningful spacing while treating an all-whitespace draft as empty. */
export function normalizeChatComposerDraft(value: string): string {
  return value.trim().length === 0 ? "" : value;
}

export function chatAttachmentDraftSignature(
  text: string,
  attachments: readonly ChatAttachment[],
  goalMode?: ChatGoalDraftMode | null,
  mentions?: readonly HumanMention[],
  replyTarget?: ChatReplyTarget | null,
): string {
  // Admission and recovery mint a new ID for each payload. Preview URLs and
  // moving the same bytes between Blob/data-URL storage do not change that owner.
  return JSON.stringify([
    text,
    goalMode ?? null,
    mentions ?? [],
    replyTarget
      ? [
          replyTarget.messageId,
          replyTarget.text,
          replyTarget.senderLabel ?? null,
          replyTarget.sourceMessageId ?? null,
        ]
      : null,
    attachments.map((attachment) => [
      attachment.id,
      attachment.mimeType,
      attachment.origin ?? null,
      attachment.fileName ?? "",
      attachment.sizeBytes ?? -1,
      attachment.browserAnnotation ?? null,
      attachment.selectionAnnotation ?? null,
    ]),
  ]);
}
