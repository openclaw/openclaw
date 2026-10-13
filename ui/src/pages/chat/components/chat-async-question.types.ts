import type { QuestionDraft } from "../../../app/question-prompt.ts";
import type { ChatQueueItem } from "../../../lib/chat/chat-types.ts";

export type AsyncQuestions = {
  itemId: string;
  sourceMessageId?: string;
  questions: { title: string; options?: string[] }[];
};

export type AsyncQuestionDraft = {
  answers: Map<string, QuestionDraft>;
  unparsedText?: string;
  edited?: boolean;
  signature?: string;
  status?: "submitting" | "submitted" | "skipped" | "reopening";
  admittedQueueId?: string;
  error?: string;
  reopenedAfterBoundary?: string;
};

export type AsyncQuestionPresentation = {
  scope: string;
  pending: AsyncQuestions[];
  archived: ReadonlyMap<string, string>;
  historyKey: string;
  drafts: Map<string, AsyncQuestionDraft>;
  resolved: ReadonlyMap<string, AsyncQuestionDraft>;
  delivery: ReadonlyMap<string, ChatQueueItem>;
  retry?: (queueId: string) => void;
  discard: (item: ChatQueueItem) => void;
  onChange: () => void;
  storageError?: string;
  dismiss: (itemId: string) => Promise<void>;
  reopen: (itemId: string) => void | Promise<void>;
  submit?: (message: string, itemId?: string, sourceMessageId?: string) => Promise<boolean>;
};
