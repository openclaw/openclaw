import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.transcript-turn.js";
import type { SessionActivitySummaryService } from "./session-activity-summaries.js";

export const target = { key: "agent:main:recap", agentId: "main" };
export const scope = {
  sessionKey: target.key,
  agentId: target.agentId,
  sessionId: "recap-session",
};
export async function messages(count: number, start = 0) {
  await persistSessionTranscriptTurn(scope, {
    messages: Array.from({ length: count }, (_, offset) => {
      const index = start + offset;
      return {
        eventId: `message-${index}`,
        parentId: index ? `message-${index - 1}` : null,
        message: {
          role: index % 2 ? "assistant" : "user",
          content: `Outcome ${index}`,
          timestamp: Date.now(),
        },
      };
    }),
    touchSessionEntry: false,
  });
}

export function terminal(service: SessionActivitySummaryService) {
  service.handleEvent({
    ...target,
    sessionKey: target.key,
    sessionId: scope.sessionId,
    runId: "run",
    seq: 1,
    ts: Date.now(),
    stream: "lifecycle",
    data: { phase: "end" },
  });
}
