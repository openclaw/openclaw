import type { AgentEventPayload } from "../infra/agent-events.js";
import { parseAgentSessionKey } from "../routing/session-key.js";

const TOOL_ACTIVITY_RECENT_LIMIT = 48;
const TOOL_PREVIEW_MAX_CHARS = 240;
const TOOL_ARGS_MAX_CHARS = 160;

export type ToolActivityStatus = "running" | "completed" | "failed";

export type ToolActivityRecord = {
  key: string;
  runId: string;
  toolCallId: string;
  sessionKey: string | null;
  agentId: string | null;
  name: string;
  status: ToolActivityStatus;
  currentPhase: string;
  startedAt: number;
  updatedAt: number;
  endedAt: number | null;
  argsPreview: string | null;
  outputPreview: string | null;
};

export type ToolActivitySnapshot = {
  summary: {
    active: number;
    recent: number;
    failedRecent: number;
    uniqueToolsActive: number;
  };
  active: ToolActivityRecord[];
  recent: ToolActivityRecord[];
};

function clampText(value: string | null | undefined, maxChars: number) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return null;
  }
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function extractText(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
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
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const item = entry as Record<string, unknown>;
      return item.type === "text" && typeof item.text === "string" ? item.text : null;
    })
    .filter((entry): entry is string => Boolean(entry));
  if (parts.length === 0) {
    return null;
  }
  return parts.join("\n");
}

function summarizeValue(value: unknown, maxChars: number): string | null {
  const text = extractText(value);
  if (text) {
    return clampText(text, maxChars);
  }
  if (value == null) {
    return null;
  }
  try {
    return clampText(JSON.stringify(value), maxChars);
  } catch {
    return null;
  }
}

function resolveAgentId(sessionKey: string | null | undefined) {
  const trimmed = sessionKey?.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "main") {
    return "main";
  }
  return parseAgentSessionKey(trimmed)?.agentId ?? null;
}

function resolveToolStatus(result: unknown): Exclude<ToolActivityStatus, "running"> {
  if (!result || typeof result !== "object") {
    return "completed";
  }
  const record = result as Record<string, unknown>;
  if (record.ok === false || typeof record.error === "string") {
    return "failed";
  }
  const details =
    record.details && typeof record.details === "object"
      ? (record.details as Record<string, unknown>)
      : null;
  const status = typeof details?.status === "string" ? details.status : null;
  if (status === "failed" || status === "killed") {
    return "failed";
  }
  return "completed";
}

export class ToolActivityRegistry {
  private active = new Map<string, ToolActivityRecord>();
  private recent = new Map<string, ToolActivityRecord>();
  private runIndex = new Map<string, Set<string>>();

  handle(event: AgentEventPayload) {
    if (event.stream === "tool") {
      this.handleToolEvent(event);
      return;
    }
    if (event.stream !== "lifecycle") {
      return;
    }
    const phase = typeof event.data?.phase === "string" ? event.data.phase : "";
    if (phase === "end" || phase === "error") {
      this.finalizeRun(event.runId, phase === "error" ? "failed" : "completed", event.ts, phase);
    }
  }

  snapshot(params?: { activeLimit?: number; recentLimit?: number }): ToolActivitySnapshot {
    const activeLimit = params?.activeLimit ?? 8;
    const recentLimit = params?.recentLimit ?? 8;
    const active = [...this.active.values()]
      .toSorted((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, activeLimit);
    const recent = [...this.recent.values()]
      .toSorted((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, recentLimit);
    return {
      summary: {
        active: this.active.size,
        recent: this.recent.size,
        failedRecent: [...this.recent.values()].filter((entry) => entry.status === "failed").length,
        uniqueToolsActive: new Set([...this.active.values()].map((entry) => entry.name)).size,
      },
      active,
      recent,
    };
  }

  private handleToolEvent(event: AgentEventPayload) {
    const data = event.data ?? {};
    const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId.trim() : "";
    if (!toolCallId) {
      return;
    }
    const phase = typeof data.phase === "string" ? data.phase : "update";
    const key = `${event.runId}:${toolCallId}`;
    const existing = this.active.get(key) ?? this.recent.get(key);
    const sessionKey = event.sessionKey?.trim() || existing?.sessionKey || null;
    const next: ToolActivityRecord = {
      key,
      runId: event.runId,
      toolCallId,
      sessionKey,
      agentId: resolveAgentId(sessionKey) ?? existing?.agentId ?? null,
      name: (typeof data.name === "string" && data.name.trim()) || existing?.name || "tool",
      status: phase === "start" ? "running" : (existing?.status ?? "running"),
      currentPhase: phase,
      startedAt: existing?.startedAt ?? event.ts,
      updatedAt: event.ts,
      endedAt: existing?.endedAt ?? null,
      argsPreview:
        phase === "start"
          ? summarizeValue(data.args, TOOL_ARGS_MAX_CHARS)
          : (existing?.argsPreview ?? null),
      outputPreview:
        phase === "result"
          ? summarizeValue(data.result, TOOL_PREVIEW_MAX_CHARS)
          : phase === "update"
            ? summarizeValue(data.partialResult, TOOL_PREVIEW_MAX_CHARS)
            : (existing?.outputPreview ?? null),
    };

    this.active.set(key, next);
    this.recent.delete(key);
    this.indexRunKey(event.runId, key);

    if (phase === "result") {
      this.finalizeEntry(key, next, resolveToolStatus(data.result), event.ts, phase);
    } else if (phase === "error") {
      next.outputPreview = summarizeValue(data.error ?? data.result, TOOL_PREVIEW_MAX_CHARS);
      this.finalizeEntry(key, next, "failed", event.ts, phase);
    }
  }

  private indexRunKey(runId: string, key: string) {
    const keys = this.runIndex.get(runId);
    if (keys) {
      keys.add(key);
      return;
    }
    this.runIndex.set(runId, new Set([key]));
  }

  private finalizeRun(
    runId: string,
    status: Exclude<ToolActivityStatus, "running">,
    ts: number,
    phase: string,
  ) {
    const keys = this.runIndex.get(runId);
    if (!keys || keys.size === 0) {
      return;
    }
    for (const key of keys) {
      const entry = this.active.get(key);
      if (!entry) {
        continue;
      }
      this.finalizeEntry(key, entry, status, ts, phase);
    }
    this.runIndex.delete(runId);
  }

  private finalizeEntry(
    key: string,
    entry: ToolActivityRecord,
    status: Exclude<ToolActivityStatus, "running">,
    ts: number,
    phase: string,
  ) {
    const finalized: ToolActivityRecord = {
      ...entry,
      status,
      currentPhase: phase,
      updatedAt: ts,
      endedAt: ts,
    };
    this.active.delete(key);
    this.recent.delete(key);
    this.recent.set(key, finalized);
    while (this.recent.size > TOOL_ACTIVITY_RECENT_LIMIT) {
      const oldestKey = this.recent.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.recent.delete(oldestKey);
    }
  }
}
