import type { SessionEntry } from "../config/sessions/types.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";

export const WIN_OLLAMA_QUARANTINE_MARKER = "win-ollama";

function normalizeComparable(value: string | undefined | null): string {
  return normalizeOptionalString(value)?.toLowerCase() ?? "";
}

function containsWinOllamaMarker(value: string | undefined | null): boolean {
  const normalized = normalizeComparable(value);
  return normalized.length > 0 && normalized.includes(WIN_OLLAMA_QUARANTINE_MARKER);
}

function isWinOllamaProvider(value: string | undefined | null): boolean {
  return normalizeComparable(value) === WIN_OLLAMA_QUARANTINE_MARKER;
}

/**
 * True when session store metadata should be treated as quarantined win-ollama
 * (hidden from default `sessions.list` / `openclaw sessions` output).
 *
 * qwen3:* / gemma4:* alone are not quarantined — only explicit win-ollama markers.
 */
export function isWinOllamaQuarantinedSessionEntry(
  entry: SessionEntry | undefined | null,
): boolean {
  if (!entry) {
    return false;
  }
  if (isWinOllamaProvider(entry.modelProvider)) {
    return true;
  }
  if (isWinOllamaProvider(entry.providerOverride)) {
    return true;
  }
  if (containsWinOllamaMarker(entry.model)) {
    return true;
  }
  if (isWinOllamaProvider(entry.origin?.provider)) {
    return true;
  }
  const originStrings = [
    entry.origin?.surface,
    entry.origin?.label,
    entry.origin?.from,
    entry.origin?.to,
  ];
  for (const value of originStrings) {
    if (containsWinOllamaMarker(value)) {
      return true;
    }
  }
  const runtimeHostStrings = [
    entry.agentHarnessId,
    entry.agentRuntimeOverride,
    entry.execHost,
    entry.execNode,
    entry.execAsk,
    entry.execSecurity,
    entry.acp?.backend,
    entry.acp?.runtimeSessionName,
    entry.acp?.agent,
    entry.systemPromptReport?.provider,
    entry.systemPromptReport?.model,
    entry.systemPromptReport?.workspaceDir,
  ];
  for (const value of runtimeHostStrings) {
    if (containsWinOllamaMarker(value)) {
      return true;
    }
  }
  return false;
}

/**
 * Cron background tasks whose payload strings reference win-ollama (default-hidden
 * from `openclaw tasks list` like quarantined sessions).
 */
export function isWinOllamaQuarantinedCronTask(task: TaskRecord | undefined | null): boolean {
  if (!task || task.runtime !== "cron") {
    return false;
  }
  const fields = [
    task.task,
    task.label,
    task.childSessionKey,
    task.requesterSessionKey,
    task.ownerKey,
    task.sourceId,
    task.runId,
    task.error,
    task.progressSummary,
    task.terminalSummary,
    task.agentId,
  ];
  return fields.some((value) => containsWinOllamaMarker(value));
}

export function isWinOllamaQuarantinedCronRunLogEntry(
  entry:
    | {
        jobId?: string;
        error?: string;
        summary?: string;
        sessionId?: string;
        sessionKey?: string;
        runId?: string;
        model?: string;
        provider?: string;
        diagnostics?: {
          summary?: string;
          entries?: Array<{ message?: string }>;
        };
        delivery?: {
          intended?: { channel?: string; to?: string | null };
          resolved?: { channel?: string; to?: string | null };
          messageToolSentTo?: Array<{ channel?: string; to?: string | null }>;
        };
      }
    | undefined
    | null,
): boolean {
  if (!entry) {
    return false;
  }
  if (isWinOllamaProvider(entry.provider)) {
    return true;
  }
  const fields = [
    entry.jobId,
    entry.error,
    entry.summary,
    entry.sessionId,
    entry.sessionKey,
    entry.runId,
    entry.model,
    entry.provider,
    entry.diagnostics?.summary,
    ...(entry.diagnostics?.entries ?? []).map((diagnostic) => diagnostic.message),
    entry.delivery?.intended?.channel,
    entry.delivery?.intended?.to,
    entry.delivery?.resolved?.channel,
    entry.delivery?.resolved?.to,
    ...(entry.delivery?.messageToolSentTo ?? []).flatMap((target) => [target.channel, target.to]),
  ];
  return fields.some((value) => containsWinOllamaMarker(value));
}
