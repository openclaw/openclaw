import {
  truncateSanitizedExternalContent,
  wrapExternalContent,
} from "../security/external-content.js";
import {
  DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS,
  toolResultFitsBudget,
  type ToolResultBudget,
} from "./tool-result-limits.js";

/** Shared by budget fitting and delivery so formatting cannot consume unreserved context. */
export function serializeToolSearchControlResult(payload: unknown): string {
  return JSON.stringify(payload);
}

/** Shared by the source projector and final formatter; no terminal receipts are consumed here. */
export function renderToolSearchControlText(
  text: string,
  networkContent: boolean,
  options: { budget?: ToolResultBudget; allowPartial?: boolean } = {},
) {
  if (!networkContent) {
    return { text, truncated: false };
  }
  const budget = options.budget ?? {
    maxChars: DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS,
    maxContextChars: Infinity,
  };
  const { maxChars } = budget;
  const bounded =
    text.length <= maxChars ? truncateSanitizedExternalContent(text, maxChars) : undefined;
  if (bounded && !bounded.truncated) {
    const wrapped = wrapExternalContent(bounded.text, { source: "api" });
    if (toolResultFitsBudget(wrapped, budget)) {
      return { text: wrapped, truncated: false };
    }
  }
  // Discovery metadata has no execution cursor. Keep its useful schema prefix.
  if (options.allowPartial) {
    let low = 0;
    let high = maxChars;
    let best = "";
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const prefix = truncateSanitizedExternalContent(text, middle).text;
      const wrapped = wrapExternalContent(`${prefix}\n[truncated]`, { source: "api" });
      if (toolResultFitsBudget(wrapped, budget)) {
        best = wrapped;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (best) {
      return { text: best, truncated: true };
    }
  }
  // A partial envelope can expose a valid next-page cursor before an incomplete
  // body. Never let that cursor silently skip the omitted part of this page.
  return {
    text: wrapExternalContent(
      "[truncated] The tool has already run, but its result exceeds the model output budget and was omitted in full. Do not advance a continuation cursor. For a read-only operation, request a smaller page from the same starting position; do not repeat a mutation just to recover its output.",
      { source: "api" },
    ),
    truncated: true,
  };
}
