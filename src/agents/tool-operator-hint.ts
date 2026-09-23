/** Keeps operator remediation separate from model-visible tool failures. */

const TOOL_OPERATOR_HINT = Symbol.for("openclaw.toolOperatorHint");

/**
 * Attach operator-facing remediation text to a tool failure. The first hint wins, so a
 * caller closer to the rejection keeps ownership of the wording. Attachment is best
 * effort: a non-extensible error is returned unchanged rather than masked.
 */
export function withToolOperatorHint<E>(error: E, hint: string): E {
  try {
    if (!(error instanceof Error) || !Object.isExtensible(error) || readToolOperatorHint(error)) {
      return error;
    }
    Object.defineProperty(error, TOOL_OPERATOR_HINT, {
      configurable: true,
      enumerable: false,
      value: hint,
      writable: true,
    });
  } catch {
    // A hint is advisory. Never let attaching one replace the failure being reported.
  }
  return error;
}

/** Read operator-facing remediation text from a tool failure, when one was attached. */
export function readToolOperatorHint(error: unknown): string | undefined {
  try {
    if (!(error instanceof Error)) {
      return undefined;
    }
    const hint: unknown = Object.getOwnPropertyDescriptor(error, TOOL_OPERATOR_HINT)?.value;
    return typeof hint === "string" && hint.trim() ? hint : undefined;
  } catch {
    return undefined;
  }
}
