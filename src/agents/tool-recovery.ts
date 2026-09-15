import { createHash } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { stableStringify } from "./stable-stringify.js";

/** Model-facing contract for explicitly associating a verification command with a failed call. */
export const TOOL_RECOVERY_VERIFICATION_DESCRIPTION =
  "Set only on a successful verification command for the same intended outcome. " +
  "Value must be the exact failed exec or Bash tool call ID. Omit for unrelated commands.";

/** Reads the declared failed call ID from an exec-like tool invocation. */
export function readToolRecoveryVerificationId(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }
  return normalizeOptionalString((args as Record<string, unknown>).verifiesRecoveryOfToolCallId);
}

/** Builds an exact call identity without including the recovery declaration itself. */
export function buildToolRecoveryFingerprint(toolName: string, args: unknown): string {
  let callArgs: unknown;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    callArgs = args;
  } else {
    const { verifiesRecoveryOfToolCallId: _recoveryDeclaration, ...rest } = args as Record<
      string,
      unknown
    >;
    callArgs = rest;
  }
  return createHash("sha256")
    .update(toolName)
    .update("\0")
    .update(stableStringify(callArgs))
    .digest("hex");
}
