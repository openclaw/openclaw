import type { QuestionDraft } from "../../../app/question-prompt.ts";

export type AsyncQuestions = {
  itemId: string;
  sourceMessageId?: string;
  questions: { title: string; options?: string[] }[];
};

export type AsyncQuestionDraft = {
  answers: Map<string, QuestionDraft>;
  edited?: boolean;
  signature?: string;
  status?: "submitting" | "submitted" | "skipped";
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
  onChange: () => void;
  storageError?: string;
  reopen: (itemId: string) => void;
  submit?: (message: string) => Promise<boolean>;
};
