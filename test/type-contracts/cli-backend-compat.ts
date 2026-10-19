import type { CliBackendParsedJsonlEvent } from "openclaw/plugin-sdk/cli-backend";

// Lifecycle events must not widen the released parser-event union.
function describeLegacyCliBackendEvent(event: CliBackendParsedJsonlEvent): string {
  switch (event.kind) {
    case "text":
    case "thinking":
      return event.text;
    case "toolStart":
      return event.name;
    case "toolResult":
      return event.toolCallId;
    case "result":
      return event.text ?? "result";
    case "sessionId":
      return event.sessionId;
  }
  const exhaustive: never = event;
  return exhaustive;
}

void describeLegacyCliBackendEvent;
