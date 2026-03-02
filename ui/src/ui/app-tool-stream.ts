import { truncateText } from "./format.ts";

const TOOL_STREAM_LIMIT = 50;
const TOOL_STREAM_THROTTLE_MS = 80;
const TOOL_OUTPUT_CHAR_LIMIT = 120_000;

export type AgentEventPayload = {
  runId: string;
  seq: number;
  stream: string;
  ts: number;
  sessionKey?: string;
  data: Record<string, unknown>;
};

export type ToolStreamEntry = {
  toolCallId: string;
  runId: string;
  sessionKey?: string;
  name: string;
  args?: unknown;
  output?: string;
  startedAt: number;
  updatedAt: number;
  message: Record<string, unknown>;
};

type ToolStreamHost = {
  sessionKey: string;
  chatRunId: string | null;
  toolStreamById: Map<string, ToolStreamEntry>;
  toolStreamOrder: string[];
  chatToolMessages: Record<string, unknown>[];
  toolStreamSyncTimer: number | null;
};

function toTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function resolveModelLabel(provider: unknown, model: unknown): string | null {
  const modelValue = toTrimmedString(model);
  if (!modelValue) {
    return null;
  }
  const providerValue = toTrimmedString(provider);
  if (providerValue) {
    const prefix = `${providerValue}/`;
    if (modelValue.toLowerCase().startsWith(prefix.toLowerCase())) {
      const trimmedModel = modelValue.slice(prefix.length).trim();
      if (trimmedModel) {
        return `${providerValue}/${trimmedModel}`;
      }
    }
    return `${providerValue}/${modelValue}`;
  }
  const slashIndex = modelValue.indexOf("/");
  if (slashIndex > 0) {
    const p = modelValue.slice(0, slashIndex).trim();
    const m = modelValue.slice(slashIndex + 1).trim();
    if (p && m) {
      return `${p}/${m}`;
    }
  }
  return modelValue;
}

type FallbackAttempt = {
  provider: string;
  model: string;
  reason: string;
};

function parseFallbackAttemptSummaries(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => toTrimmedString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function parseFallbackAttempts(value: unknown): FallbackAttempt[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: FallbackAttempt[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const item = entry as Record<string, unknown>;
    const provider = toTrimmedString(item.provider);
    const model = toTrimmedString(item.model);
    if (!provider || !model) {
      continue;
    }
    const reason =
      toTrimmedString(item.reason)?.replace(/_/g, " ") ??
      toTrimmedString(item.code) ??
      (typeof item.status === "number" ? `HTTP ${item.status}` : null) ??
      toTrimmedString(item.error) ??
      "error";
    out.push({ provider, model, reason });
  }
  return out;
}

function extractToolOutputText(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text;
  }
  const content = record.content;
  if (!Array.isArray(content)) {
    return null;
  }
  const parts = content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const entry = item as Record<string, unknown>;
      if (entry.type === "text" && typeof entry.text === "string") {
        return entry.text;
      }
      return null;
    })
    .filter((part): part is string => Boolean(part));
  if (parts.length === 0) {
    return null;
  }
  return parts.join("\n");
}

function formatToolOutput(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const contentText = extractToolOutputText(value);
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (contentText) {
    text = contentText;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      // oxlint-disable typescript/no-base-to-string
      text = String(value);
    }
  }
  const truncated = truncateText(text, TOOL_OUTPUT_CHAR_LIMIT);
  if (!truncated.truncated) {
    return truncated.text;
  }
  return `${truncated.text}\n\n… truncated (${truncated.total} chars, showing first ${truncated.text.length}).`;
}

function buildToolStreamMessage(entry: ToolStreamEntry): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  content.push({
    type: "toolcall",
    name: entry.name,
    arguments: entry.args ?? {},
  });
  if (entry.output) {
    content.push({
      type: "toolresult",
      name: entry.name,
      text: entry.output,
    });
  }
  return {
    role: "assistant",
    toolCallId: entry.toolCallId,
    runId: entry.runId,
    content,
    timestamp: entry.startedAt,
  };
}

function trimToolStream(host: ToolStreamHost) {
  if (host.toolStreamOrder.length <= TOOL_STREAM_LIMIT) {
    return;
  }
  const overflow = host.toolStreamOrder.length - TOOL_STREAM_LIMIT;
  const removed = host.toolStreamOrder.splice(0, overflow);
  for (const id of removed) {
    host.toolStreamById.delete(id);
  }
}

function syncToolStreamMessages(host: ToolStreamHost) {
  host.chatToolMessages = host.toolStreamOrder
    .map((id) => host.toolStreamById.get(id)?.message)
    .filter((msg): msg is Record<string, unknown> => Boolean(msg));
}

export function flushToolStreamSync(host: ToolStreamHost) {
  if (host.toolStreamSyncTimer != null) {
    clearTimeout(host.toolStreamSyncTimer);
    host.toolStreamSyncTimer = null;
  }
  syncToolStreamMessages(host);
}

export function scheduleToolStreamSync(host: ToolStreamHost, force = false) {
  if (force) {
    flushToolStreamSync(host);
    return;
  }
  if (host.toolStreamSyncTimer != null) {
    return;
  }
  host.toolStreamSyncTimer = window.setTimeout(
    () => flushToolStreamSync(host),
    TOOL_STREAM_THROTTLE_MS,
  );
}

export function resetToolStream(host: ToolStreamHost) {
  host.toolStreamById.clear();
  host.toolStreamOrder = [];
  host.chatToolMessages = [];
  flushToolStreamSync(host);
}

export type CompactionStatus = {
  active: boolean;
  startedAt: number | null;
  completedAt: number | null;
};

export type FallbackStatus = {
  phase?: "active" | "cleared";
  selected: string;
  active: string;
  previous?: string;
  reason?: string;
  attempts: string[];
  occurredAt: number;
};

type CompactionHost = ToolStreamHost & {
  compactionStatus?: CompactionStatus | null;
  compactionClearTimer?: number | null;
  fallbackStatus?: FallbackStatus | null;
  fallbackClearTimer?: number | null;
};

const COMPACTION_TOAST_DURATION_MS = 5000;
const FALLBACK_TOAST_DURATION_MS = 8000;

export function handleCompactionEvent(host: CompactionHost, payload: AgentEventPayload) {
  const data = payload.data ?? {};
  const phase = typeof data.phase === "string" ? data.phase : "";

  // Clear any existing timer
  if (host.compactionClearTimer != null) {
    window.clearTimeout(host.compactionClearTimer);
    host.compactionClearTimer = null;
  }

  if (phase === "start") {
    host.compactionStatus = {
      active: true,
      startedAt: Date.now(),
      completedAt: null,
    };
  } else if (phase === "end") {
    host.compactionStatus = {
      active: false,
      startedAt: host.compactionStatus?.startedAt ?? null,
      completedAt: Date.now(),
    };
    // Auto-clear the toast after duration
    host.compactionClearTimer = window.setTimeout(() => {
      host.compactionStatus = null;
      host.compactionClearTimer = null;
    }, COMPACTION_TOAST_DURATION_MS);
  }
}

function resolveAcceptedSession(
  host: ToolStreamHost,
  payload: AgentEventPayload,
  options?: {
    allowSessionScopedWhenIdle?: boolean;
  },
): { accepted: boolean; sessionKey?: string } {
  const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : undefined;
  if (sessionKey && sessionKey !== host.sessionKey) {
    return { accepted: false };
  }
  if (!host.chatRunId && options?.allowSessionScopedWhenIdle && sessionKey) {
    return { accepted: true, sessionKey };
  }
  // Fallback: only accept session-less events for the active run.
  if (!sessionKey && host.chatRunId && payload.runId !== host.chatRunId) {
    return { accepted: false };
  }
  if (host.chatRunId && payload.runId !== host.chatRunId) {
    return { accepted: false };
  }
  if (!host.chatRunId) {
    return { accepted: false };
  }
  return { accepted: true, sessionKey };
}

function handleLifecycleFallbackEvent(host: CompactionHost, payload: AgentEventPayload) {
  const data = payload.data ?? {};
  const phase = payload.stream === "fallback" ? "fallback" : toTrimmedString(data.phase);
  if (payload.stream === "lifecycle" && phase !== "fallback" && phase !== "fallback_cleared") {
    return;
  }

  const accepted = resolveAcceptedSession(host, payload, { allowSessionScopedWhenIdle: true });
  if (!accepted.accepted) {
    return;
  }

  const selected =
    resolveModelLabel(data.selectedProvider, data.selectedModel) ??
    resolveModelLabel(data.fromProvider, data.fromModel);
  const active =
    resolveModelLabel(data.activeProvider, data.activeModel) ??
    resolveModelLabel(data.toProvider, data.toModel);
  const previous =
    resolveModelLabel(data.previousActiveProvider, data.previousActiveModel) ??
    toTrimmedString(data.previousActiveModel);
  if (!selected || !active) {
    return;
  }
  if (phase === "fallback" && selected === active) {
    return;
  }

  const reason = toTrimmedString(data.reasonSummary) ?? toTrimmedString(data.reason);
  const attempts = (() => {
    const summaries = parseFallbackAttemptSummaries(data.attemptSummaries);
    if (summaries.length > 0) {
      return summaries;
    }
    return parseFallbackAttempts(data.attempts).map((attempt) => {
      const modelRef = resolveModelLabel(attempt.provider, attempt.model);
      return `${modelRef ?? `${attempt.provider}/${attempt.model}`}: ${attempt.reason}`;
    });
  })();

  if (host.fallbackClearTimer != null) {
    window.clearTimeout(host.fallbackClearTimer);
    host.fallbackClearTimer = null;
  }
  host.fallbackStatus = {
    phase: phase === "fallback_cleared" ? "cleared" : "active",
    selected,
    active: phase === "fallback_cleared" ? selected : active,
    previous:
      phase === "fallback_cleared"
        ? (previous ?? (active !== selected ? active : undefined))
        : undefined,
    reason: reason ?? undefined,
    attempts,
    occurredAt: Date.now(),
  };
  host.fallbackClearTimer = window.setTimeout(() => {
    host.fallbackStatus = null;
    host.fallbackClearTimer = null;
  }, FALLBACK_TOAST_DURATION_MS);
}

export function handleAgentEvent(host: ToolStreamHost, payload?: AgentEventPayload) {
  if (!payload) {
    return;
  }

  // Handle compaction events
  if (payload.stream === "compaction") {
    handleCompactionEvent(host as CompactionHost, payload);
    return;
  }

  if (payload.stream === "lifecycle" || payload.stream === "fallback") {
    handleLifecycleFallbackEvent(host as CompactionHost, payload);
    return;
  }

  if (payload.stream !== "tool") {
    return;
  }
  const accepted = resolveAcceptedSession(host, payload);
  if (!accepted.accepted) {
    return;
  }
  const sessionKey = accepted.sessionKey;

  const data = payload.data ?? {};
  const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : "";
  if (!toolCallId) {
    return;
  }
  const name = typeof data.name === "string" ? data.name : "tool";
  const phase = typeof data.phase === "string" ? data.phase : "";
  const args = phase === "start" ? data.args : undefined;
  const output =
    phase === "update"
      ? formatToolOutput(data.partialResult)
      : phase === "result"
        ? formatToolOutput(data.result)
        : undefined;

  const now = Date.now();
  let entry = host.toolStreamById.get(toolCallId);
  if (!entry) {
    entry = {
      toolCallId,
      runId: payload.runId,
      sessionKey,
      name,
      args,
      output: output || undefined,
      startedAt: typeof payload.ts === "number" ? payload.ts : now,
      updatedAt: now,
      message: {},
    };
    host.toolStreamById.set(toolCallId, entry);
    host.toolStreamOrder.push(toolCallId);
  } else {
    entry.name = name;
    if (args !== undefined) {
      entry.args = args;
    }
    if (output !== undefined) {
      entry.output = output || undefined;
    }
    entry.updatedAt = now;
  }

  entry.message = buildToolStreamMessage(entry);
  trimToolStream(host);
  scheduleToolStreamSync(host, phase === "result");
}
