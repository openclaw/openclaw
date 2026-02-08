/**
 * Error thrown when a tool call is blocked by policy (e.g., guardrails).
 */
export class ToolBlockedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ToolBlockedError";
  }
}

export function isToolBlockedError(err: unknown): err is ToolBlockedError {
  return err instanceof ToolBlockedError;
}
