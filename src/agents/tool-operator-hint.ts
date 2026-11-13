/** Keeps operator remediation separate from model-visible tool failures. */

const TOOL_OPERATOR_HINT = Symbol.for("openclaw.toolOperatorHint");

/**
 * Attach operator-facing remediation text to a tool failure. The first hint wins, so a
 * caller closer to the rejection keeps ownership of the wording. Non-extensible
 * errors are returned unchanged.
 */
export function withToolOperatorHint<E>(error: E, hint: string): E {
  if (!(error instanceof Error) || !Object.isExtensible(error) || readToolOperatorHint(error)) {
    return error;
  }
  Object.defineProperty(error, TOOL_OPERATOR_HINT, {
    configurable: true,
    enumerable: false,
    value: hint,
    writable: true,
  });
  return error;
}

export function readToolOperatorHint(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const hint: unknown = Object.getOwnPropertyDescriptor(error, TOOL_OPERATOR_HINT)?.value;
  return typeof hint === "string" && hint.trim() ? hint : undefined;
}
