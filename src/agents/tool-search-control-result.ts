import {
  truncateSanitizedExternalContent,
  wrapExternalContent,
} from "../security/external-content.js";
import { resolveLiveToolResultMaxChars } from "./tool-result-limits.js";

export const DEFAULT_TOOL_SEARCH_MAX_RESULT_CHARS = 20_000;
const TRUNCATED_SUFFIX = "\n[truncated]";
const MIN_TOOL_SEARCH_MAX_RESULT_CHARS = TRUNCATED_SUFFIX.length + 1;
const EXTERNAL_API_WRAPPER_CHARS = wrapExternalContent("", { source: "api" }).length;

/** Resolve the pre-wrapper character budget for network-sourced Tool Search control results. */
export function resolveToolSearchResultMaxChars(params?: {
  maxResultChars?: number | "auto";
  modelContextWindowTokens?: number;
}): number {
  const maxResultChars = params?.maxResultChars;
  const contextTokens = params?.modelContextWindowTokens;
  const liveInnerCap =
    typeof contextTokens === "number" && Number.isFinite(contextTokens) && contextTokens > 0
      ? Math.max(
          MIN_TOOL_SEARCH_MAX_RESULT_CHARS,
          resolveLiveToolResultMaxChars({ contextWindowTokens: contextTokens }) -
            EXTERNAL_API_WRAPPER_CHARS,
        )
      : undefined;
  if (maxResultChars === undefined) {
    return DEFAULT_TOOL_SEARCH_MAX_RESULT_CHARS;
  }
  if (maxResultChars === "auto") {
    return liveInnerCap ?? DEFAULT_TOOL_SEARCH_MAX_RESULT_CHARS;
  }
  const requested = Math.max(MIN_TOOL_SEARCH_MAX_RESULT_CHARS, Math.floor(maxResultChars));
  return liveInnerCap !== undefined ? Math.min(requested, liveInnerCap) : requested;
}

/** Shared by budget fitting and delivery so formatting cannot consume unreserved context. */
export function serializeToolSearchControlResult(payload: unknown, compact = false): string {
  return JSON.stringify(payload, null, compact ? undefined : 2);
}

/** Shared by the source projector and final formatter; no terminal receipts are consumed here. */
export function renderToolSearchControlText(
  text: string,
  networkContent: boolean,
  maxChars = DEFAULT_TOOL_SEARCH_MAX_RESULT_CHARS,
) {
  if (!networkContent) {
    return { text, truncated: false };
  }
  const limit = Math.max(MIN_TOOL_SEARCH_MAX_RESULT_CHARS, Math.floor(maxChars));
  const prefixLimit = limit - TRUNCATED_SUFFIX.length;
  const bounded = text.length <= limit ? truncateSanitizedExternalContent(text, limit) : undefined;
  const truncated = bounded?.truncated ?? true;
  const modelText =
    !bounded || bounded.truncated
      ? `${truncateSanitizedExternalContent(text, prefixLimit).text}${TRUNCATED_SUFFIX}`
      : bounded.text;
  return { text: wrapExternalContent(modelText, { source: "api" }), truncated };
}
