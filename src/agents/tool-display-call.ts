import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";

// Current and shipped dispatcher names. Kept local: tool-search-types pulls session types,
// and activity projection imports this display leaf (architecture import cycle).
const TOOL_CALL_DISPLAY_NAMES = new Set(["dispatch_action", "tool_call"]);

/** Transport prefix CLI harnesses use for loopback OpenClaw MCP tool names. */
const OPENCLAW_MCP_TOOL_PREFIX = "mcp__openclaw__";
const GEMINI_OPENCLAW_MCP_TOOL_PREFIX = "mcp_openclaw_";

/** Strips the loopback MCP transport prefix so observers see gateway tool names. */
export function stripOpenClawMcpToolPrefix(toolName: string): string {
  return toolName.startsWith(OPENCLAW_MCP_TOOL_PREFIX)
    ? toolName.slice(OPENCLAW_MCP_TOOL_PREFIX.length)
    : toolName.startsWith(GEMINI_OPENCLAW_MCP_TOOL_PREFIX)
      ? toolName.slice(GEMINI_OPENCLAW_MCP_TOOL_PREFIX.length)
      : toolName;
}

/** Project the called tool for presentation without changing invocation identity or results. */
export function unwrapToolCallForDisplay<Name extends string | undefined>(call: {
  name: Name;
  args?: unknown;
}): { name: Name | string; args?: unknown } {
  // CLI history keeps the bridged name; present the gateway tool the live events show.
  const name = call.name === undefined ? call.name : stripOpenClawMcpToolPrefix(call.name);
  const args = asOptionalRecord(call.args);
  const id = typeof args?.id === "string" ? args.id.trim() : "";
  if (!TOOL_CALL_DISPLAY_NAMES.has(name?.trim().toLowerCase() ?? "") || !id) {
    return name === call.name ? call : { name, args: call.args };
  }
  const innerArgs = args?.args;
  const prototype = isRecord(innerArgs) ? Object.getPrototypeOf(innerArgs) : undefined;
  return {
    // The catalog owns source:sourceName:toolName IDs; ordinary names pass through.
    name: id.match(/^(?:openclaw|mcp|client):[^:]+:(.+)$/u)?.[1] ?? id,
    args: prototype === Object.prototype || prototype === null ? innerArgs : {},
  };
}
