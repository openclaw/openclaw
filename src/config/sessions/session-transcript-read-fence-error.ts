/**
 * Thrown when a transcript read crosses the current-turn admission fence, such as a
 * stored cursor that already passed the admitted user message during bootstrap or assembly.
 */
export class SessionTranscriptReadFenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionTranscriptReadFenceError";
  }
}

/** Recognizes the public error across host/plugin bundle copies. */
export function isSessionTranscriptReadFenceError(
  error: unknown,
): error is SessionTranscriptReadFenceError {
  return (
    error !== null &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "SessionTranscriptReadFenceError" &&
    "message" in error &&
    typeof error.message === "string"
  );
}

/** Finds the bounded transcript diagnostic through host-owned error wrappers. */
export function findSessionTranscriptReadFenceError(
  error: unknown,
): SessionTranscriptReadFenceError | undefined {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.shift();
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (isSessionTranscriptReadFenceError(current)) {
      return current;
    }
    if (current instanceof AggregateError) {
      pending.push(...current.errors);
    }
    if (current instanceof Error && current.cause !== undefined) {
      pending.push(current.cause);
    }
  }
  return undefined;
}
