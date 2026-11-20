import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";

const REASONING_REPLAY_FIELDS = [
  "reasoning_details",
  "reasoning_content",
  "reasoning",
  "reasoning_text",
] as const;

const OMITTED_ASSISTANT_REASONING_TEXT = "[assistant reasoning omitted]";

function stripReasoningReplayFields(value: unknown): void {
  const record = asOptionalObjectRecord(value);
  if (!record) {
    return;
  }
  for (const field of REASONING_REPLAY_FIELDS) {
    delete record[field];
  }

  const content = record.content;
  if (Array.isArray(content)) {
    const nextContent = stripReasoningReplayItems(content);
    record.content =
      nextContent.length > 0
        ? nextContent
        : [{ type: "text", text: OMITTED_ASSISTANT_REASONING_TEXT }];
  }
}

function stripReasoningReplayItems(items: unknown[]): unknown[] {
  const retained = [];
  for (const item of items) {
    const type = asOptionalObjectRecord(item)?.type;
    if (type !== "thinking" && type !== "redacted_thinking" && type !== "reasoning") {
      stripReasoningReplayFields(item);
      retained.push(item);
    }
  }
  return retained;
}

/** Remove unsupported reasoning from a mutable outbound payload, retaining visible content. */
export function stripReasoningReplayPayload(payload: Record<string, unknown>): void {
  stripReasoningReplayFields(payload);
  delete payload.reasoning_effort;
  delete payload.reasoningEffort;
  for (const key of ["messages", "input"] as const) {
    if (Array.isArray(payload[key])) {
      payload[key] = stripReasoningReplayItems(payload[key]);
    }
  }
}
