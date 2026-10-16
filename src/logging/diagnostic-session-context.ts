import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { prepareCronJobNameResolver } from "../cron/store/job-name.js";
import { areDiagnosticsEnabledForProcess } from "../infra/diagnostic-events.js";
import {
  isIncognitoSessionKey,
  isValidAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { diagnosticLogger as diag } from "./diagnostic-runtime.js";

type SessionDiagnosticContext = {
  cronJobId?: string;
  cronRunId?: string;
  cronJobName?: string;
};

type SessionDiagnosticTarget = {
  sessionKey?: string;
};

async function withSessionDiagnosticContext(
  params: SessionDiagnosticTarget,
  consume: (context: SessionDiagnosticContext) => void,
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
  if (context.cronJobId) {
    try {
      const resolveName = await prepareCronJobNameResolver([context.cronJobId]);
      context.cronJobName = resolveName(context.cronJobId);
    } catch {
      // Display enrichment is optional, including a retired resolver.
    }
  }
  consume(context);
}

function formatSessionDiagnosticFields(
  context: SessionDiagnosticContext,
  cronNameLabel: "cronJob" | "stopped" = "cronJob",
): string {
  const quote = (value: string) => {
    const oneLine = value.replace(/\s+/g, " ").trim();
    const bounded = oneLine.length > 140 ? `${truncateUtf16Safe(oneLine, 137)}...` : oneLine;
    return `"${bounded.replace(/["\\]/g, "\\$&")}"`;
  };
  return [
    context.cronJobId ? `cronJobId=${context.cronJobId}` : "",
    context.cronRunId ? `cronRunId=${context.cronRunId}` : "",
    context.cronJobName ? `${cronNameLabel}=${quote(context.cronJobName)}` : "",
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
  if (!areDiagnosticsEnabledForProcess() || !diag.isEnabled(params.level)) {
    return undefined;
  }
  return withSessionDiagnosticContext(params, (context) => {
    diag[params.level](params.format(formatSessionDiagnosticFields(context, params.cronNameLabel)));
  });
}
