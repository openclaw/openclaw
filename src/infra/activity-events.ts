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
  | "subagent.end";

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
