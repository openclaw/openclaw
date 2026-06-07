// Talk realtime chat final adapter.
// Consumes generic chat-run final notifications and lets the Talk relay claim owned runs.
import type { ChatRunFinalNotification } from "./server-chat.js";
import { formatForLog } from "./ws-log.js";

function buildTalkRealtimeFinalResult(event: ChatRunFinalNotification): Record<string, string> {
  if (event.state === "done") {
    return event.text?.trim() ? { response: event.text.trim() } : {};
  }
  return { error: event.error === undefined ? "OpenClaw run failed." : formatForLog(event.error) };
}

export async function deliverTalkRealtimeChatRunFinal(
  event: ChatRunFinalNotification,
): Promise<boolean> {
  const { deliverTalkRealtimeRelayAgentRunFinal } = await import("./talk-realtime-relay.js");
  const result = buildTalkRealtimeFinalResult(event);
  const delivered = deliverTalkRealtimeRelayAgentRunFinal({
    runId: event.clientRunId,
    sessionKey: event.sessionKey,
    result,
    source: "agent-final",
  });
  if (delivered || event.sourceRunId === event.clientRunId) {
    return delivered;
  }
  return deliverTalkRealtimeRelayAgentRunFinal({
    runId: event.sourceRunId,
    sessionKey: event.sessionKey,
    result,
    source: "agent-final",
  });
}
