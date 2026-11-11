import type { AgentMessage } from "@openclaw/agent-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY } from "../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import { memoizeFrozenPlainDataProjection } from "./immutable-data.js";

// Native replay retains the exact submitted prompt. Model-context consumers already
// have its visible content; copying this storage-only payload duplicates the prompt.
export const MODEL_CONTEXT_PRIVATE_METADATA_KEYS = ["upstreamUserText"] as const;

/** Keep delivery and pairing semantics without exposing opaque tool metadata. */
export function projectToolResultDetailsForModel(
  value: unknown,
): Record<string, unknown> | undefined {
  const details = asOptionalRecord(value);
  if (!details) {
    return undefined;
  }
  const whole = details.contentPolicy === "whole";
  const missing = details[SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY] === true;
  if (!whole && !missing) {
    return undefined;
  }
  if (Object.keys(details).length === Number(whole) + Number(missing)) {
    return details;
  }
  return {
    ...(whole ? { contentPolicy: "whole" } : {}),
    ...(missing ? { [SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY]: true } : {}),
  };
}

const stripDetails = memoizeFrozenPlainDataProjection((record: Record<string, unknown>) => {
  const details = projectToolResultDetailsForModel(record.details);
  if (details && details === record.details) {
    return record;
  }
  const sanitized = { ...record };
  if (details) {
    sanitized.details = details;
  } else {
    delete sanitized.details;
  }
  return sanitized;
});

export function stripToolResultDetails(messages: AgentMessage[]): AgentMessage[];
export function stripToolResultDetails(messages: unknown[]): unknown[];
export function stripToolResultDetails(messages: unknown[]): unknown[] {
  let touched = false;
  const out = messages.map((message) => {
    const record = asOptionalRecord(message);
    if (record?.role !== "toolResult" || !("details" in record)) {
      return message;
    }
    const sanitized = stripDetails(record);
    touched ||= sanitized !== message;
    return sanitized;
  });
  return touched ? out : messages;
}

/** A transient view; evidence and persistence readers must retain the original messages. */
export function projectModelContextMessages(
  messages: AgentMessage[],
  onFreshMetadata?: (metadata: Record<string, unknown>) => void,
): AgentMessage[];
export function projectModelContextMessages(
  messages: unknown[],
  onFreshMetadata?: (metadata: Record<string, unknown>) => void,
): unknown[];
export function projectModelContextMessages(
  messages: unknown[],
  onFreshMetadata?: (metadata: Record<string, unknown>) => void,
): unknown[] {
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
    // This mutable envelope belongs only to this projection, never to its source or cache.
    onFreshMetadata?.(projected);
    output.push({ ...record, __openclaw: projected });
  }
  return output;
}
