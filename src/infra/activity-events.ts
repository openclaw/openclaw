import { emitAgentEvent } from "./agent-events.js";

export type ActivityEventKind =
  | "run.start"
  | "run.end"
  | "run.error"
  | "tool.start"
  | "tool.end"
  | "thinking.start"
  | "thinking.end"
  | "subagent.start"
  | "subagent.end"
  | "subagent.completed";

export type ActivityEventData = {
  kind: ActivityEventKind;
  agentId?: string;
  parentRunId?: string;
  depth?: number;
  toolName?: string;
  toolCallId?: string;
  durationMs?: number;
  isError?: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
};

const DEFAULT_METADATA_MAX_LEN = 2048;

export function summarizeForMetadata(
  value: unknown,
  maxLen = DEFAULT_METADATA_MAX_LEN,
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  try {
    const json = typeof value === "string" ? value : JSON.stringify(value);
    if (json.length <= maxLen) {
      return json;
    }
    return `${json.slice(0, maxLen)}…`;
  } catch {
    return undefined;
  }
}

export function emitActivityEvent(
  runId: string,
  data: ActivityEventData,
  sessionKey?: string,
): void {
  emitAgentEvent({
    runId,
    stream: "activity",
    data: data as Record<string, unknown>,
    sessionKey,
  });
}
