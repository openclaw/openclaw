import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";

// Tool Search's dispatcher name. Kept local: tool-search-types pulls session types,
// and activity projection imports this display leaf (architecture import cycle).
const TOOL_CALL_RAW_TOOL_NAME = "tool_call";

/** Project the called tool for presentation without changing invocation identity or results. */
export function unwrapToolCallForDisplay<Name extends string | undefined>(call: {
  name: Name;
  args?: unknown;
}): { name: Name | string; args?: unknown } {
  const args = asOptionalRecord(call.args);
  const id = typeof args?.id === "string" ? args.id.trim() : "";
  if (call.name?.trim().toLowerCase() !== TOOL_CALL_RAW_TOOL_NAME || !id) {
    return call;
  }
  const innerArgs = args?.args;
  const prototype = isRecord(innerArgs) ? Object.getPrototypeOf(innerArgs) : undefined;
  return {
    // The catalog owns source:sourceName:toolName IDs; ordinary names pass through.
    name: id.match(/^(?:openclaw|mcp|client):[^:]+:(.+)$/u)?.[1] ?? id,
    args: prototype === Object.prototype || prototype === null ? innerArgs : {},
  };
}
