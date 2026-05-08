import { loadSqliteSessionTranscriptEvents } from "../config/sessions/transcript-store.sqlite.js";
import { loadCronStoreSync, resolveCronStorePath } from "../cron/store.js";

const MAX_QUOTED_FIELD_CHARS = 140;

type CronSessionContext = {
  agentId?: string;
  cronJobId?: string;
  cronRunId?: string;
  cronJobName?: string;
  lastAssistant?: string;
};

function quoteLogField(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  const truncated =
    oneLine.length > MAX_QUOTED_FIELD_CHARS
      ? `${oneLine.slice(0, Math.max(0, MAX_QUOTED_FIELD_CHARS - 3))}...`
      : oneLine;
  return `"${truncated.replace(/["\\]/g, "\\$&")}"`;
}

export function parseCronRunSessionKey(sessionKey?: string): {
  agentId?: string;
  cronJobId?: string;
  cronRunId?: string;
} {
  const parts = sessionKey?.trim().split(":") ?? [];
  if (parts[0] !== "agent") {
    return {};
  }
  const cronIndex = parts.indexOf("cron");
  if (cronIndex < 2) {
    return {};
  }
  const runIndex = parts.indexOf("run", cronIndex + 2);
  return {
    agentId: parts[1],
    cronJobId: parts[cronIndex + 1],
    cronRunId: runIndex >= 0 ? parts[runIndex + 1] : undefined,
  };
}

function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const texts = content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return undefined;
      }
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : undefined;
    })
    .filter((text): text is string => Boolean(text?.trim()));
  return texts.length ? texts.join(" ") : undefined;
}

function readAssistantTextFromTranscriptEvent(event: unknown): string | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return undefined;
  }
  const message = (event as { message?: { role?: unknown; content?: unknown } }).message;
  if (message?.role !== "assistant") {
    return undefined;
  }
  return textFromContent(message.content)?.trim();
}

export function readLastAssistantFromSqliteTranscript(params: {
  agentId?: string;
  sessionId?: string;
}): string | undefined {
  const agentId = params.agentId?.trim();
  const sessionId = params.sessionId?.trim();
  if (!agentId || !sessionId) {
    return undefined;
  }
  try {
    const events = loadSqliteSessionTranscriptEvents({ agentId, sessionId });
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const text = readAssistantTextFromTranscriptEvent(events[index].event);
      if (text) {
        return text;
      }
    }
  } catch {
    // Diagnostic context is best-effort and must never block recovery logging.
  }
  return undefined;
}

function readCronJobName(cronJobId: string | undefined): string | undefined {
  if (!cronJobId) {
    return undefined;
  }
  try {
    const store = loadCronStoreSync(resolveCronStorePath());
    const job = store.jobs.find((entry) => entry.id === cronJobId);
    return typeof job?.name === "string" && job.name.trim() ? job.name.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function resolveCronSessionDiagnosticContext(params: {
  sessionKey?: string;
  activeSessionId?: string;
}): CronSessionContext {
  const parsed = parseCronRunSessionKey(params.sessionKey);
  if (!parsed.cronJobId && !parsed.cronRunId) {
    return {};
  }
  return {
    ...parsed,
    cronJobName: readCronJobName(parsed.cronJobId),
    lastAssistant: readLastAssistantFromSqliteTranscript({
      agentId: parsed.agentId,
      sessionId: params.activeSessionId?.trim() || parsed.cronRunId,
    }),
  };
}

export function formatCronSessionDiagnosticFields(context: CronSessionContext): string {
  const fields: string[] = [];
  if (context.cronJobId) {
    fields.push(`cronJobId=${context.cronJobId}`);
  }
  if (context.cronRunId) {
    fields.push(`cronRunId=${context.cronRunId}`);
  }
  if (context.cronJobName) {
    fields.push(`cronJob=${quoteLogField(context.cronJobName)}`);
  }
  if (context.lastAssistant) {
    fields.push(`lastAssistant=${quoteLogField(context.lastAssistant)}`);
  }
  return fields.join(" ");
}

export function formatStoppedCronSessionDiagnosticFields(context: CronSessionContext): string {
  const fields: string[] = [];
  if (context.cronJobName) {
    fields.push(`stopped=${quoteLogField(context.cronJobName)}`);
  }
  const rest = formatCronSessionDiagnosticFields({
    cronJobId: context.cronJobId,
    cronRunId: context.cronRunId,
    lastAssistant: context.lastAssistant,
  });
  if (rest) {
    fields.push(rest);
  }
  return fields.join(" ");
}

export const __testing = {
  quoteLogField,
};
