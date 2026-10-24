/** A captured question can never acquire a successor database or session incarnation. */
export class SessionQuestionCustodyRetiredError extends Error {
  override name = "SessionQuestionCustodyRetiredError";
  readonly code = "question-custody-retired";
}
