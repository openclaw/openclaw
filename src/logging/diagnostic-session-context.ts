import { boundSessionDiagnosticText } from "../config/sessions/session-diagnostic-text.js";
import { withSessionDiagnosticTextInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { prepareCronJobNameResolver } from "../cron/store/job-name.js";
import { areDiagnosticsEnabledForProcess } from "../infra/diagnostic-events.js";
import {
  isIncognitoSessionKey,
  isValidAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { diagnosticLogger as diag } from "./diagnostic-runtime.js";

type SessionDiagnosticContext = {
  cronJobId?: string;
  cronRunId?: string;
  cronJobName?: string;
  lastAssistant?: string;
};

type SessionDiagnosticTarget = {
  sessionKey?: string;
  activeSessionId?: string;
};

let logGeneration = 0;

export function retireSessionDiagnosticLogs(): void {
  logGeneration += 1;
}

async function withSessionDiagnosticContext(
  params: SessionDiagnosticTarget,
  consume: (context: SessionDiagnosticContext) => void,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const sessionKey = params.sessionKey?.trim();
  const parsed = parseAgentSessionKey(sessionKey);
  if (
    !sessionKey ||
    !parsed ||
    !isValidAgentId(parsed.agentId) ||
    isIncognitoSessionKey(sessionKey)
  ) {
    consume({});
    return;
  }
  const [kind, cronJobId, ...rest] = parsed.rest.split(":");
  const runIndex = rest.indexOf("run");
  const context: SessionDiagnosticContext =
    kind === "cron" && cronJobId
      ? { cronJobId, cronRunId: runIndex >= 0 ? rest[runIndex + 1] : undefined }
      : {};
  const sessionId = params.activeSessionId?.trim();
  let identityChanged = false;
  const unsubscribe = onSessionIdentityMutation((mutation) => {
    if (
      mutation.previous.sessionKeys.includes(sessionKey) ||
      ("current" in mutation && mutation.current.sessionKeys.includes(sessionKey)) ||
      (mutation.agentId === parsed.agentId &&
        sessionId &&
        mutation.previous.sessionId === sessionId)
    ) {
      identityChanged = true;
    }
  });
  const assertCurrent = () => {
    if (identityChanged || !isCurrent()) {
      throw new Error("Diagnostic session context is no longer current");
    }
  };
  let consumed = false;
  const publish = (value: SessionDiagnosticContext) => {
    assertCurrent();
    consumed = true;
    consume(value);
  };
  try {
    assertCurrent();
    if (context.cronJobId) {
      const resolveName = await prepareCronJobNameResolver([context.cronJobId]).catch(
        () => undefined,
      );
      assertCurrent();
      context.cronJobName = resolveName?.(context.cronJobId);
    }
    if (sessionId) {
      await withSessionDiagnosticTextInWorker(
        { agentId: parsed.agentId, sessionKey, sessionId },
        assertCurrent,
        (lastAssistant) => publish({ ...context, lastAssistant }),
      );
    } else {
      publish(context);
    }
  } catch {
    // Enrichment cannot delay recovery or publish a replaced session's text.
    if (!consumed && isCurrent()) {
      consume(identityChanged ? {} : context);
    }
  } finally {
    unsubscribe();
  }
}

function formatSessionDiagnosticFields(
  context: SessionDiagnosticContext,
  cronNameLabel: "cronJob" | "stopped" = "cronJob",
): string {
  const quote = (value: string) =>
    `"${boundSessionDiagnosticText(value).replace(/["\\]/g, "\\$&")}"`;
  return [
    context.cronJobId ? `cronJobId=${context.cronJobId}` : "",
    context.cronRunId ? `cronRunId=${context.cronRunId}` : "",
    context.cronJobName ? `${cronNameLabel}=${quote(context.cronJobName)}` : "",
    context.lastAssistant ? `lastAssistant=${quote(context.lastAssistant)}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Recovery and event publication never wait for optional display enrichment. */
export function logWithSessionDiagnosticContext(
  params: SessionDiagnosticTarget & {
    level: "debug" | "warn";
    format: (fields: string) => string;
    cronNameLabel?: "cronJob" | "stopped";
  },
): Promise<void> | undefined {
  const generation = logGeneration;
  const isCurrent = () => areDiagnosticsEnabledForProcess() && generation === logGeneration;
  if (!isCurrent() || !diag.isEnabled(params.level)) {
    return undefined;
  }
  return withSessionDiagnosticContext(
    params,
    (context) => {
      if (isCurrent() && diag.isEnabled(params.level)) {
        diag[params.level](
          params.format(formatSessionDiagnosticFields(context, params.cronNameLabel)),
        );
      }
    },
    isCurrent,
  );
}
