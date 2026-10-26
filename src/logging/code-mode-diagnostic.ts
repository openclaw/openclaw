import { createHash } from "node:crypto";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import {
  diagnosticErrorCategory,
  diagnosticErrorFailureKind,
} from "../infra/diagnostic-error-metadata.js";
import { isTruthyEnvValue } from "../infra/env.js";
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
  failureCode?: string;
  bridgeDispatchStarted?: boolean;
  bridgeRequestId?: string;
  bridgeMethod?: string;
};

/** Record failure categories and correlation without message or tool content. */
export function logCodeModeFailure(error: unknown, context: CodeModeFailureContext): void {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  const level =
    context.failurePhase === "guest" ||
    context.failurePhase === "input" ||
    context.failureCode === "invalid_input" ||
    context.failureCode === "input_contract" ||
    context.failureCode === "store_range" ||
    context.failureCode === "store_type"
      ? "warn"
      : "error";
  failureLog[level]("Code Mode execution failed", {
    ...context,
    errorCode:
      extractErrorCode(cause) === "ERR_WORKER_OUT_OF_MEMORY"
        ? "ERR_WORKER_OUT_OF_MEMORY"
        : undefined,
    errorCategory: diagnosticErrorCategory(cause),
    failureKind: diagnosticErrorFailureKind(cause),
  });
}

export function isCodeModeDiagnosticEnabled(): boolean {
  return isTruthyEnvValue(process.env.OPENCLAW_DEBUG_CODE_MODE);
}

export function logCodeModeDiagnostic(
  log: Pick<SubsystemLogger, "info">,
  boundary: string,
  fields: Record<string, boolean | number | string | readonly string[] | undefined>,
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

/** Prepare only correlation metadata; never send the session key into a guest worker. */
export function codeModeGcAttribution(runId: string, sessionKey?: string) {
  return {
    runId,
    sessionKeyHash: sessionKey
      ? createHash("sha256").update(sessionKey).digest("hex").slice(0, 16)
      : undefined,
  };
}
