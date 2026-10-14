import { recordModelFallbackStop } from "../agents/model-fallback-stop.js";

export class WorkerNodeLostError extends Error {
  readonly code = "node-lost";

  constructor(options?: ErrorOptions) {
    // A command may have completed before disconnection; loss is not proof of failed effects.
    super(
      "The node disconnected before the turn finished. Tool effects may be unknown; verify state before retrying.",
      options,
    );
    this.name = "WorkerNodeLostError";
    recordModelFallbackStop(this);
  }
}
