/**
 * Shared logic for summarizing ephemeral / repetitive tool results before they
 * are sent to the LLM.  Replacing variable-length tool output with a
 * fixed-format summary prevents the output from breaking prefix-cache
 * continuity (e.g. DeepSeek prefix cache hit rate collapsing from ~100 % to
 * ~18 % when heartbeat outputs are inserted verbatim).
 *
 * The tool-call pairing (assistant `tool_calls` → `role:"tool"` / tool_result)
 * is preserved — only the text payload is replaced with a stable digest, so
 * providers that require call-result pairing remain satisfied.
 *
 * IMPORTANT: The summary must be *content-stable* — it must not include any
 * portion of the original tool output, because variable content (timestamps,
 * status text, notification messages, etc.) still changes the model-visible
 * bytes and defeats prefix-cache reuse.  The fixed format
 * `[ephemeral tool result: {toolName}]` guarantees identical bytes for every
 * invocation of the same tool name.
 */

/**
 * Tool names whose outputs are ephemeral / repetitive and should be summarized
 * to a fixed-length placeholder in the prompt sent to the LLM.
 *
 * These tools produce outputs that vary between calls (timestamps, status
 * fields, file contents, etc.) but whose content the LLM rarely needs to
 * reason about in detail.  Summarising them preserves prefix-cache continuity.
 */
export const EPHEMERAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "heartbeat_respond",
  "session_status",
  "exec",
  "mcporter",
  "read",
  "web",
  "memory",
]);

/**
 * Return `true` when the given tool name belongs to the ephemeral set and its
 * result should be summarized instead of forwarded verbatim.
 */
export function isEphemeralToolName(toolName: string): boolean {
  return EPHEMERAL_TOOL_NAMES.has(toolName);
}

/**
 * Summarize the text of an ephemeral tool result.  The summary is a
 * *content-stable* fixed format: `[ephemeral tool result: {toolName}]`.
 * No portion of the original output is included, because any variable content
 * (timestamps, status fields, file contents, etc.) would change the
 * model-visible bytes and break prefix-cache reuse.
 */
export function summarizeEphemeralToolResult(toolName: string, _text: string): string {
  return `[ephemeral tool result: ${toolName}]`;
}
