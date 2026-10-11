export const QuestionManagerErrorCodes = {
  NOT_FOUND: "QUESTION_NOT_FOUND",
  ALREADY_TERMINAL: "QUESTION_ALREADY_TERMINAL",
  ID_IN_USE: "QUESTION_ID_IN_USE",
  INVALID_ANSWER: "QUESTION_INVALID_ANSWER",
  REQUESTER_INACTIVE: "QUESTION_REQUESTER_INACTIVE",
} as const;

type QuestionManagerErrorCode =
  (typeof QuestionManagerErrorCodes)[keyof typeof QuestionManagerErrorCodes];

export class QuestionManagerError extends Error {
  constructor(
    readonly code: QuestionManagerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "QuestionManagerError";
  }
}

export function invalidQuestionAnswerError(id: string, reason: string): QuestionManagerError {
  return new QuestionManagerError(
    QuestionManagerErrorCodes.INVALID_ANSWER,
    `question '${id}' ${reason}`,
  );
}
