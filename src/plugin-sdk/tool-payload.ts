import {
  parseStandalonePlainTextToolCallBlocks as parseStandaloneRepairToolCallBlocks,
  stripPlainTextToolCallBlocks as stripRepairToolCallBlocks,
} from "../../packages/tool-call-repair/src/index.js";

export type PlainTextToolCallBlock = {
  /** Parsed JSON/XML parameter object for the recovered tool call. */
  arguments: Record<string, unknown>;
  /** Exclusive offset where the standalone block ends in the source text. */
  end: number;
  /** Tool name recovered from the bracketed, Harmony, or XML-style marker. */
  name: string;
  /** Exact text span consumed for this tool call. */
  raw: string;
  /** Inclusive offset where the standalone block starts in the source text. */
  start: number;
};

export type PlainTextToolCallParseOptions = {
  /** Optional allowlist used to reject hallucinated or unsupported tool names. */
  allowedToolNames?: Iterable<string>;
  /** Maximum accepted serialized argument payload before a candidate is ignored. */
  maxPayloadBytes?: number;
};

/** Parse local-model plaintext tool-call blocks that escaped normal structured tool routing. */
export function parseStandalonePlainTextToolCallBlocks(
  text: string,
  options?: PlainTextToolCallParseOptions,
): PlainTextToolCallBlock[] | null {
  return parseStandaloneRepairToolCallBlocks(text, options);
}

/** Remove standalone plaintext tool-call blocks before user-visible reply text is sent. */
export function stripPlainTextToolCallBlocks(text: string): string {
  return stripRepairToolCallBlocks(text);
}

type ToolPayloadTextBlock = {
  type: "text";
  text: string;
};

export type ToolPayloadCarrier = {
  /** Structured payload returned by native action runners; preferred over text content. */
  details?: unknown;
  /** ACP-style content blocks or legacy raw content returned by older helpers. */
  content?: unknown;
};

function isToolPayloadTextBlock(block: unknown): block is ToolPayloadTextBlock {
  return (
    Boolean(block) &&
    typeof block === "object" &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
  );
}

/**
 * Extract the most useful payload from tool result-like objects shared across
 * outbound core flows and bundled plugin helpers.
 */
export function extractToolPayload(result: ToolPayloadCarrier | null | undefined): unknown {
  if (!result) {
    return undefined;
  }
  if (result.details !== undefined) {
    // Native action runners already normalized payloads into `details`; text content is
    // usually a user-facing rendering and must not override that structured value.
    return result.details;
  }
  const textBlock = Array.isArray(result.content)
    ? result.content.find(isToolPayloadTextBlock)
    : undefined;
  const text = textBlock?.text;
  if (!text) {
    return result.content ?? result;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
