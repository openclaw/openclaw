/** Validates argument boundaries for command-owned session directives. */
import type { ReplyPayload } from "../types.js";
import type { InlineDirectives } from "./directive-handling.parse.js";

export function resolveInvalidExecDirectiveMessage(
  directives: InlineDirectives,
): string | undefined {
  return directives.invalidExecHost
    ? `Unrecognized exec host "${directives.rawExecHost ?? ""}". Valid hosts: auto, sandbox, gateway, node.`
    : directives.invalidExecSecurity
      ? `Unrecognized exec security "${directives.rawExecSecurity ?? ""}". Valid: deny, allowlist, full.`
      : directives.invalidExecAsk
        ? `Unrecognized exec ask "${directives.rawExecAsk ?? ""}". Valid: off, on-miss, always.`
        : directives.invalidExecNode
          ? "Exec node requires a value."
          : undefined;
}

/** Rejects prose left over after canonical command-specific validation succeeds. */
export function maybeHandleUnexpectedDirectiveArguments(
  directives: InlineDirectives,
): ReplyPayload | undefined {
  const command = directives.command;
  const unconsumedArguments = command?.unconsumedArguments;
  if (!command || !unconsumedArguments) {
    return undefined;
  }

  // One token is enough to explain the rejected boundary without echoing an unbounded prompt.
  const unexpectedArgument =
    unconsumedArguments.trimStart().split(/\s+/, 1)[0] ?? unconsumedArguments;
  return {
    text: `Unexpected argument "${unexpectedArgument}" for /${command.name}.`,
  };
}
