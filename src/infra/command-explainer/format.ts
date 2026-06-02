import type { ExecApprovalCommandSpan } from "../exec-approvals.js";
import { normalizeExecutableToken } from "../exec-wrapper-tokens.js";
import {
  isShellWrapperExecutable,
  POSIX_SHELL_WRAPPERS,
  resolveShellWrapperTransportArgv,
} from "../shell-wrapper-resolution.js";
import type { CommandExplanation } from "./types.js";

const POSIX_COMMAND_HIGHLIGHT_SHELLS: ReadonlySet<string> = POSIX_SHELL_WRAPPERS;

function spanToCommandSpan(span: {
  startIndex: number;
  endIndex: number;
}): ExecApprovalCommandSpan | null {
  if (!Number.isSafeInteger(span.startIndex) || !Number.isSafeInteger(span.endIndex)) {
    return null;
  }
  if (span.startIndex < 0 || span.endIndex <= span.startIndex) {
    return null;
  }
  return { startIndex: span.startIndex, endIndex: span.endIndex };
}

function isUnsupportedShellWrapperArgv(argv: readonly string[]): boolean {
  const shellWrapperArgv = resolveShellWrapperTransportArgv([...argv]) ?? argv;
  const executable = shellWrapperArgv[0];
  if (!executable) {
    return false;
  }
  const normalizedExecutable = normalizeExecutableToken(executable);
  return (
    isShellWrapperExecutable(normalizedExecutable) &&
    !POSIX_COMMAND_HIGHLIGHT_SHELLS.has(normalizedExecutable)
  );
}

function hasUnsupportedShellWrapper(explanation: CommandExplanation): boolean {
  return explanation.topLevelCommands.some((command) =>
    isUnsupportedShellWrapperArgv(command.argv),
  );
}

/**
 * Converts rich command explanations into approval-highlight byte spans.
 * Unsupported wrapper shells opt out entirely because their nested payload
 * offsets are not guaranteed to point at the original source text.
 */
export function formatCommandSpans(explanation: CommandExplanation): ExecApprovalCommandSpan[] {
  if (hasUnsupportedShellWrapper(explanation)) {
    return [];
  }
  const commandSpans: ExecApprovalCommandSpan[] = [];

  for (const command of [...explanation.topLevelCommands, ...explanation.nestedCommands]) {
    const commandSpan = spanToCommandSpan(command.executableSpan);
    if (commandSpan) {
      commandSpans.push(commandSpan);
    }
  }
  return commandSpans;
}
