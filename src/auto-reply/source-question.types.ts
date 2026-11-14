import type { AgentHarnessUserInputQuestion } from "../agents/harness/user-input-types.js";

/** Ordinary business input only; credential, resource and external-auth flows retain their owners. */
export type SourceBusinessQuestionV1 = Pick<
  AgentHarnessUserInputQuestion,
  "id" | "header" | "question" | "multiSelect" | "isOther" | "answerFormat" | "allowEmpty"
> & {
  options?: readonly Readonly<{ label: string; description?: string; value?: string }>[];
};

/** Host-created identity; only its original question owner can admit an answer to it. */
export type SourceQuestionV1 = Readonly<{
  version: 1;
  questions: readonly SourceBusinessQuestionV1[];
  expiresAtMs: number;
  signal: AbortSignal;
}>;

export type SourceQuestionAnswerReceiptV1 =
  | Readonly<{ status: "confirmed"; resolutionId: string }>
  | Readonly<{
      status: "refused";
      reason: "stale-question" | "source-refused" | "invalid-answer" | "unsupported";
    }>
  | Readonly<{ status: "unconfirmed" }>;

/** Input intent never grants the source or incumbent run additional authority. */
export type SourceQuestionInputV1 =
  | Readonly<{
      version: 1;
      mode: "new-task";
      onQuestion?: (question: SourceQuestionV1) => Promise<void>;
    }>
  | Readonly<{
      version: 1;
      mode: "answer-only";
      question: SourceQuestionV1;
      onReceipt: (receipt: SourceQuestionAnswerReceiptV1) => Promise<void> | void;
    }>;
