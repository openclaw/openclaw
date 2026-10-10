import type { AgentMessage } from "@openclaw/agent-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY } from "../../packages/agent-core/src/harness/session/tool-result-pairing.js";

// Native replay retains the exact submitted prompt. Model-context consumers already
// have its visible content; copying this storage-only payload duplicates the prompt.
export const MODEL_CONTEXT_PRIVATE_METADATA_KEYS = ["upstreamUserText"] as const;

export function stripToolResultDetails(messages: AgentMessage[]): AgentMessage[];
export function stripToolResultDetails(messages: unknown[]): unknown[];
export function stripToolResultDetails(messages: unknown[]): unknown[] {
  let touched = false;
  const out = messages.map((message) => {
    const record = asOptionalRecord(message);
    if (record?.role !== "toolResult" || !("details" in record)) {
      return message;
    }
    const sanitized = { ...record };
    const details = asOptionalRecord(record.details);
    if (details?.[SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY] === true) {
      if (Object.keys(details).length === 1) {
        return message;
      }
      sanitized.details = { [SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY]: true };
    } else {
      delete sanitized.details;
    }
    touched = true;
    return sanitized;
  });
  return touched ? out : messages;
}

/** A transient view; evidence and persistence readers must retain the original messages. */
export function projectModelContextMessages(messages: AgentMessage[]): AgentMessage[];
export function projectModelContextMessages(messages: unknown[]): unknown[];
export function projectModelContextMessages(messages: unknown[]): unknown[] {
  const output: unknown[] = [];
  for (const message of stripToolResultDetails(messages)) {
    const record = asOptionalRecord(message);
    const metadata = asOptionalRecord(record?.["__openclaw"]);
    if (!metadata || !MODEL_CONTEXT_PRIVATE_METADATA_KEYS.some((key) => key in metadata)) {
      output.push(message);
      continue;
    }
    const projected = { ...metadata };
    for (const key of MODEL_CONTEXT_PRIVATE_METADATA_KEYS) {
      delete projected[key];
    }
    output.push({ ...record, __openclaw: projected });
  }
  return output;
}
