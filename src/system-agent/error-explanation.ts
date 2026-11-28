import { ConnectErrorDetailCodes } from "../../packages/gateway-protocol/src/connect-error-details.js";
import { isContextOverflowErrorFromTables } from "../agents/failover/context-overflow-tables.js";

const EXPLAIN_ERROR_PREFIX = /^\s*explain[ \t]+error[ \t]*:/iu;
const MAX_ERROR_LENGTH = 8_000;

export const SYSTEM_AGENT_ERROR_HISTORY_TEXT = "Explain error: [error text omitted]";

const explanations = [
  {
    matches: (line: string) =>
      /^OpenClaw config is invalid\.?$|^Invalid config at .+:$/iu.test(line),
    cause: "OpenClaw found a configuration file it could not parse or validate.",
    next: "Run `openclaw config validate` on the machine running OpenClaw to identify the invalid settings without saving changes.",
  },
  {
    matches: (line: string) => /^No API key found for provider "[^"\r\n]+"\./iu.test(line),
    cause: "OpenClaw couldn't find an API key it could use for the selected model provider.",
    next: "Run `openclaw models status` for the affected agent to see its model and authentication status.",
  },
  {
    matches: (line: string) =>
      line === ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH ||
      /^(?:gateway closed \([^)]*\):\s*)?unauthorized: gateway token mismatch\b/iu.test(line),
    cause: "The Gateway didn't accept the shared token the client supplied.",
    next: "Check that the client is pointing at the intended Gateway before changing any credentials.",
  },
  {
    // Limit the runtime's overflow heuristics to explicit error lines, not prose about limits.
    matches: (line: string) =>
      /^(?:context overflow:|context length exceeded\b|context_window_exceeded\b|prompt is too long\b)/iu.test(
        line,
      ) && isContextOverflowErrorFromTables(line),
    cause: "The request was too large for the model's available room for input and output.",
    next: "Try a shorter request in a fresh chat, leaving this conversation intact.",
  },
] as const;

export function systemAgentErrorPasteOffset(input: string): number | undefined {
  return EXPLAIN_ERROR_PREFIX.exec(input)?.[0].length;
}

/** An explicit, presentation-only turn. Returns fixed guidance without running a check. */
export function explainPastedSystemAgentError(input: string | undefined): string | undefined {
  if (input === undefined) {
    return undefined;
  }
  const pasteOffset = systemAgentErrorPasteOffset(input);
  if (pasteOffset === undefined) {
    return undefined;
  }
  return explainSystemAgentError(input.slice(pasteOffset));
}

export function explainSystemAgentError(error: string): string {
  if (error.length > MAX_ERROR_LENGTH) {
    return "That paste is too long for a local check. Send `explain error:` followed by just the relevant error line, with secrets removed.";
  }
  const [headline, ...details] = error
    .split(/\r?\n/u)
    .map((line) => line.trim().replace(/^(?:Error|InvalidConfigError):[ \t]*/u, ""))
    .filter(Boolean);
  // A recognizable line later in a log may belong to a different attempt.
  const match = headline ? explanations.find(({ matches }) => matches(headline)) : undefined;
  if (!match) {
    return "There isn't enough information to identify the cause. For a local check, send `explain error:` followed by the exact error line, without secrets. For further troubleshooting, note what you were doing and your OpenClaw version.";
  }
  if (explanations.some((other) => other !== match && details.some(other.matches))) {
    return "This paste contains more than one recognizable error. Send `explain error:` followed by just the error line for the action that failed, with secrets removed.";
  }
  return `Likely cause: ${match.cause}\n\nNext step: ${match.next}`;
}
