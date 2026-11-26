import { isRecord } from "@openclaw/normalization-core/record-coerce";

// The cold summarizer sends SUMMARIZATION_SYSTEM_PROMPT; the warm request is the session's
// normal request plus one trailing user instruction from summary-checkpoint-prompt.ts.
const COLD_SUMMARY_SYSTEM_PROMPT = "context summarization assistant";
const WARM_SUMMARY_INSTRUCTION = "The messages above are ";

function text(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  return Array.isArray(content)
    ? content
        .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
        .join("")
    : "";
}

/** Whether a provider request body is a built-in compaction summary request, cold or warm. */
export function isCompactionSummaryRequest(raw: string): boolean {
  if (raw.includes(COLD_SUMMARY_SYSTEM_PROMPT)) {
    return true;
  }
  const body: unknown = JSON.parse(raw);
  if (!isRecord(body)) {
    return false;
  }
  const items = Array.isArray(body.input) ? body.input : body.messages;
  const last = Array.isArray(items) ? items.at(-1) : undefined;
  return (
    isRecord(last) &&
    last.role === "user" &&
    text(last.content).startsWith(WARM_SUMMARY_INSTRUCTION)
  );
}
