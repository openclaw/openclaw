import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isTruthyEnvValue } from "../infra/env.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "./subsystem.js";
import type { SubsystemLogger } from "./subsystem.js";

const MAX_NAMES = 24;
const MAX_NAME_LENGTH = 80;
const failureLog = createSubsystemLogger("agents/code-mode");

export type CodeModeFailureContext = {
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  toolCallId?: string;
  codeModeRunId?: string;
  workerId?: string;
  failurePhase: string;
  bridgeDispatchStarted?: boolean;
  bridgeRequestId?: string;
  bridgeMethod?: string;
};

/** Record the producer's cause before guest projection or output budgeting. */
export function logCodeModeFailure(error: unknown, context: CodeModeFailureContext): void {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  const record = isRecord(cause) ? cause : undefined;
  const name = cause instanceof Error ? cause.name : record?.name;
  const message = cause instanceof Error ? cause.message : record?.message;
  const stack = cause instanceof Error ? cause.stack : record?.stack;
  failureLog.error("Code Mode execution failed", {
    ...context,
    errorName: typeof name === "string" ? name : "Error",
    errorCode: typeof record?.code === "string" ? record.code : undefined,
    error: typeof message === "string" ? message : formatErrorMessage(error),
    stack: typeof stack === "string" ? stack.split("\n").slice(0, 12).join("\n") : undefined,
  });
}

type CodeModeDiagnosticFields = Record<
  string,
  boolean | number | string | readonly string[] | undefined
>;

export function isCodeModeDiagnosticEnabled(): boolean {
  return isTruthyEnvValue(process.env.OPENCLAW_DEBUG_CODE_MODE);
}

export function logCodeModeDiagnostic(
  log: Pick<SubsystemLogger, "info">,
  boundary: string,
  fields: CodeModeDiagnosticFields,
): void {
  if (!isCodeModeDiagnosticEnabled()) {
    return;
  }
  const bounded = Object.fromEntries(
    Object.entries(fields).map(([key, value]) => {
      if (Array.isArray(value)) {
        const names = [...new Set(value.map((name) => name.slice(0, MAX_NAME_LENGTH)))];
        names.sort((left, right) => left.localeCompare(right));
        return [key, names.slice(0, MAX_NAMES)];
      }
      return [key, typeof value === "string" ? value.slice(0, MAX_NAME_LENGTH) : value];
    }),
  );
  log.info(`code-mode diagnostic ${JSON.stringify({ boundary, ...bounded })}`);
}
