import {
  truncateSanitizedExternalContent,
  wrapExternalContent,
} from "../security/external-content.js";

/** Shared by budget fitting and delivery so formatting cannot consume unreserved context. */
export function serializeToolSearchControlResult(payload: unknown, compact = false): string {
  return JSON.stringify(payload, null, compact ? undefined : 2);
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
