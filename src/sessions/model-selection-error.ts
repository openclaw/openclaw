export const MODEL_SELECTION_LOCKED_MESSAGE = "Model selection is locked for this session.";

/** Retains the caller-visible refusal across the database worker boundary. */
export class ModelSelectionLockedError extends Error {
  constructor(message = MODEL_SELECTION_LOCKED_MESSAGE) {
    super(message);
    this.name = "ModelSelectionLockedError";
  }
}
