import type { SupervisorEvent } from "./types.js";

export function normalizeSupervisorUserEvent(params: {
  body: string;
  sessionId: string;
  source: string;
  timestamp?: number;
}): SupervisorEvent {
  const body = params.body.trim();
  return {
    type: "user_message",
    category: "user",
    source: params.source,
    timestamp: params.timestamp ?? Date.now(),
    payload: {
      text: body,
      bodyPreview: body.replace(/\s+/g, " ").slice(0, 160),
    },
    urgency: "normal",
    scope: "foreground",
    relatedSessionId: params.sessionId,
  };
}
