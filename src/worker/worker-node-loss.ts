import { recordModelFallbackStop } from "../agents/model-fallback-stop.js";

export class WorkerNodeLostError extends Error {
  readonly code = "node-lost";
  canContinue = false;

  constructor(options?: ErrorOptions) {
    // A non-idempotent command may have completed before disconnection; its effects need verification.
    super(
      "The node disconnected before the turn finished. Tool effects may be unknown; verify state before retrying.",
      options,
    );
    this.name = "WorkerNodeLostError";
    recordModelFallbackStop(this);
  }
}
