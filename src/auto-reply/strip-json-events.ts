/**
 * Filter out raw JSON event lines from text before external delivery.
 * These are internal gateway/agent events that should never be sent to WhatsApp.
 */
export function stripJsonEventLines(text: string): string {
  if (!text) return "";
  const lines = text.split(/\n/);
  const kept: string[] = [];
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      kept.push(line);
      continue;
    }
    if (trimmedLine.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmedLine);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          typeof parsed.type === "string" &&
          [
            "message_start",
            "message_update",
            "message_end",
            "turn_start",
            "turn_end",
            "agent_start",
            "agent_end",
            "tool_start",
            "tool_end",
            "heartbeat",
            "input_audio_buffer.append",
          ].includes(parsed.type)
        ) {
          continue;
        }
      } catch {
        // Not valid JSON, keep the line
      }
    }
    kept.push(line);
  }
  return kept.join("\n").trim();
}
