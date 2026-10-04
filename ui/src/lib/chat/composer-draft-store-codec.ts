import type {
  DurableComposerDraft,
  DurableComposerDraftAttachment,
  DurableComposerDraftScope,
  DurableQuestionDraft,
} from "./chat-types.ts";
import { isChatGoalDraftMode } from "./goal-draft.ts";
import { readHumanMentions } from "./human-mentions.ts";
import { isChatReplyTarget } from "./reply-target.ts";

export type StoredDurableComposerDraft = DurableComposerDraft &
  DurableComposerDraftScope & {
    key: string;
    ownerKey: string;
    updatedAt: number;
    writeId: string;
  };

function isStoredAttachment(value: unknown): value is DurableComposerDraftAttachment {
  if (!value || typeof value !== "object") {
    return false;
  }
  // SAFETY: IDB data is untrusted; every consumed field is validated below.
  const attachment = value as Partial<DurableComposerDraftAttachment>;
  return (
    attachment.blob instanceof Blob &&
    typeof attachment.mimeType === "string" &&
    (attachment.origin === undefined ||
      attachment.origin === "paste" ||
      attachment.origin === "file")
  );
}

function isQuestionDraft(value: unknown): value is DurableQuestionDraft {
  if (!value || typeof value !== "object") {
    return false;
  }
  // SAFETY: Only validation reads this view; all draft fields and nested answers are checked below.
  const draft = value as Partial<DurableQuestionDraft>;
  return (
    typeof draft.itemId === "string" &&
    typeof draft.signature === "string" &&
    typeof draft.edited === "boolean" &&
    (draft.dismissed === undefined || typeof draft.dismissed === "boolean") &&
    (draft.reopenedAfterBoundary === undefined ||
      typeof draft.reopenedAfterBoundary === "string") &&
    Array.isArray(draft.answers) &&
    draft.answers.every(
      (answer) =>
        answer &&
        typeof answer === "object" &&
        typeof answer.freeText === "string" &&
        Array.isArray(answer.selected) &&
        answer.selected.every((option) => typeof option === "string"),
    )
  );
}

export function parseStoredDraft(value: unknown): StoredDurableComposerDraft | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  // SAFETY: IDB data is untrusted; every required record field is validated below.
  const record = value as Partial<StoredDurableComposerDraft>;
  if (
    typeof record.key !== "string" ||
    typeof record.ownerKey !== "string" ||
    typeof record.gatewayOwner !== "string" ||
    typeof record.recoveryScope !== "string" ||
    typeof record.scopeKey !== "string" ||
    typeof record.updatedAt !== "number" ||
    typeof record.writeId !== "string" ||
    typeof record.text !== "string" ||
    (record.goalMode !== undefined && !isChatGoalDraftMode(record.goalMode)) ||
    (record.replyTarget !== undefined && !isChatReplyTarget(record.replyTarget)) ||
    typeof record.revision !== "number" ||
    !Number.isSafeInteger(record.revision) ||
    record.revision <= 0 ||
    !Array.isArray(record.attachments) ||
    !record.attachments.every(isStoredAttachment) ||
    (record.questionDrafts !== undefined &&
      (!Array.isArray(record.questionDrafts) || !record.questionDrafts.every(isQuestionDraft)))
  ) {
    return null;
  }
  const selection = record.modelSelection;
  if (
    selection !== undefined &&
    (!selection ||
      typeof selection !== "object" ||
      typeof selection.agentId !== "string" ||
      typeof selection.model !== "string" ||
      typeof selection.thinkingLevel !== "string" ||
      (selection.agentRuntime !== undefined && typeof selection.agentRuntime !== "string"))
  ) {
    record.modelSelection = undefined;
  }
  record.mentions = readHumanMentions(record.text, record.mentions);
  // SAFETY: the complete stored shape and every attachment payload were validated above.
  return record as StoredDurableComposerDraft;
}
