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
  status?: "submitting" | "submitted" | "skipped" | "reopening";
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
  dismiss: (itemId: string) => Promise<void>;
  reopen: (itemId: string) => void | Promise<void>;
  submit?: (message: string) => Promise<boolean>;
};
