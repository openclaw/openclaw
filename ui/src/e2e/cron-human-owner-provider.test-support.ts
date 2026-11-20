import type { ServerResponse } from "node:http";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.ts";

// Existing session-activity-summaries.ts purpose contract, not a model/tool heuristic.
const recapPrompt =
  "Write an Activity recap for someone scanning their tasks: what was done here, and where it stands now.";

function inputText(value: unknown, role: string): string | undefined {
  if (!isRecord(value) || value.type !== "message" || value.role !== role) {
    return undefined;
  }
  const content = value.content;
  if (!Array.isArray(content) || content.length !== 1) {
    return undefined;
  }
  const part: unknown = content[0];
  return isRecord(part) && part.type === "input_text" && typeof part.text === "string"
    ? part.text
    : undefined;
}

export function respondToActivityRecap(response: ServerResponse, request: unknown): boolean {
  if (!isRecord(request) || !Array.isArray(request.input) || request.input.length !== 2) {
    return false;
  }
  if (request.tools !== undefined && (!Array.isArray(request.tools) || request.tools.length)) {
    return false;
  }
  const system = inputText(request.input[0], "system");
  const user = inputText(request.input[1], "user");
  if (!system?.startsWith(`${recapPrompt} `) || user === undefined) {
    return false;
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(user);
  } catch {
    return false;
  }
  if (
    !isRecord(envelope) ||
    Object.keys(envelope).length !== 3 ||
    typeof envelope.previousRecap !== "string" ||
    !Array.isArray(envelope.messages) ||
    typeof envelope.omittedContent !== "boolean"
  ) {
    return false;
  }
  writeOpenAiResponsesText(response, {
    text: "The automation wrote its execution witness and completed.",
    messageId: "activity-recap-message",
    responseId: "activity-recap-response",
  });
  return true;
}
