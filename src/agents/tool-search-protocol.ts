import type { AgentToolSurfacePresentation } from "../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import { TOOL_CALL_RAW_TOOL_NAME } from "./tool-catalog.js";

export const TOOL_SEARCH_RAW_TOOL_NAME = "tool_search";
export const TOOL_DESCRIBE_RAW_TOOL_NAME = "tool_describe";
export { TOOL_CALL_RAW_TOOL_NAME } from "./tool-catalog.js";
// One model-visible search response, including a batch, may expose at most this many candidates.
export const MAX_TOOL_SEARCH_RESULTS = 50;
export const MAX_TOOL_SEARCH_BATCH_QUERIES = 16;
export const MAX_TOOL_SEARCH_BATCH_QUERY_GRAPHEMES = 512;
// Includes JSON escaping and multibyte text echoed to identify batch result groups.
export const MAX_TOOL_SEARCH_BATCH_QUERY_BYTES = 512;
export const MAX_TOOL_SEARCH_BATCH_RESPONSE_CHARS = 4_000;

export const TOOL_SEARCH_CONTROL_TOOL_NAMES = new Set([
  TOOL_SEARCH_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_CALL_RAW_TOOL_NAME,
]);

export const TOOL_SCHEMA_DIRECTORY_CONTROL_TOOL_NAMES = new Set([
  TOOL_SEARCH_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_CALL_RAW_TOOL_NAME,
]);

export type ToolSearchMode = "tools" | "directory";
export type ToolSearchRequest =
  | { kind: "single"; search: { query: string; limit: number } }
  | { kind: "batch"; searches: Array<{ query: string; limit: number }> };
export type CatalogSource = "openclaw" | "mcp" | "client";
export type CatalogVisibilityOptions = {
  includeMcp?: boolean;
  allowedIds?: { has(id: string): boolean };
};
type UnknownToolRecoverySurface = "raw-tools" | "catalog";
export type UnknownToolErrorOptions = {
  exactIdOnly?: boolean;
  recoverySurface?: UnknownToolRecoverySurface;
};

/** Resolved Tool Search config after defaults and limits. */
export type ToolSearchConfig = AgentToolSurfacePresentation["toolSearch"];
