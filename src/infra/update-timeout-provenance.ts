import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

export type UpdateTimeoutHandoff = {
  completionOwner: "parent";
  timeout: { version: 1; serialized: string; operator: string | null };
};

/** Keep a compatibility allowance for shipped receivers and retain the caller's intent. */
export function createUpdateTimeoutHandoff(
  operatorTimeout: string | undefined,
  fallbackTimeoutMs: number,
): UpdateTimeoutHandoff {
  return {
    completionOwner: "parent",
    timeout: {
      version: 1,
      serialized: operatorTimeout ?? String(Math.ceil(fallbackTimeoutMs / 1000)),
      operator: operatorTimeout ?? null,
    },
  };
}

/** Unknown or mismatched private input cannot remove a shipped caller's deadline. */
export function isOmittedUpdateTimeout(serialized: string | undefined, handoff: unknown): boolean {
  if (!serialized || !parseStrictPositiveInteger(serialized) || !isRecord(handoff)) {
    return false;
  }
  const timeout = handoff.timeout;
  return (
    handoff.completionOwner === "parent" &&
    isRecord(timeout) &&
    timeout.version === 1 &&
    timeout.operator === null &&
    timeout.serialized === serialized
  );
}
