import {
  truncateSanitizedExternalContent,
  wrapExternalContent,
} from "../security/external-content.js";

/** Shared by budget fitting and delivery so formatting cannot consume unreserved context. */
export function serializeToolSearchControlResult(payload: unknown, compact = false): string {
  return JSON.stringify(payload, null, compact ? undefined : 2);
}

/** Render the exact text blocks used for fitting and final delivery. */
export function renderToolSearchControlContent(
  payload: unknown,
  networkContent: boolean,
  options: {
    compact?: boolean;
    mcpServerInstructions?: Record<string, string>;
    mcpServerInstructionsOmitted?: boolean;
  } = {},
) {
  const payloads = options.mcpServerInstructions
    ? [payload, { mcpServerInstructions: options.mcpServerInstructions }]
    : [payload];
  if (options.mcpServerInstructionsOmitted) {
    // Keep this short semantic block independent of attacker-sized catalog metadata.
    // The live guard preserves it while truncating the oversized payload.
    payloads.unshift({
      notice:
        "MCP server instructions were omitted because this response has no room for guidance markers. Try a narrower tool_search request.",
    });
  }
  return payloads.map((value) =>
    renderToolSearchControlText(
      serializeToolSearchControlResult(value, options.compact),
      networkContent,
    ),
  );
}

/** Shared by the source projector and final formatter; no terminal receipts are consumed here. */
export function renderToolSearchControlText(text: string, networkContent: boolean) {
  if (!networkContent) {
    return { text, truncated: false };
  }
  const bounded =
    text.length <= 20_000 ? truncateSanitizedExternalContent(text, 20_000) : undefined;
  const truncated = bounded?.truncated ?? true;
  const modelText =
    !bounded || bounded.truncated
      ? `${truncateSanitizedExternalContent(text, 19_988).text}\n[truncated]`
      : bounded.text;
  return { text: wrapExternalContent(modelText, { source: "api" }), truncated };
}
