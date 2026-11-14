import {
  foldIssuedExternalContent,
  truncateSanitizedExternalContent,
  wrapExternalContent,
} from "../security/external-content.js";

/** Shared by budget fitting and delivery so formatting cannot consume unreserved context. */
export function serializeToolSearchControlResult(payload: unknown): string {
  return JSON.stringify(payload);
}

/** Shared by the source projector and final formatter; no terminal receipts are consumed here. */
export function renderToolSearchControlText(text: string, networkContent: boolean) {
  if (!networkContent) {
    return { text, truncated: false };
  }
  // web_fetch and web_search wrap their own fields; fold the envelopes this
  // process issued so this single wrap does not turn them into [[MARKER_SANITIZED]] text.
  const source = foldIssuedExternalContent(text, 200_000);
  const bounded =
    source.length <= 20_000 ? truncateSanitizedExternalContent(source, 20_000) : undefined;
  const truncated = bounded?.truncated ?? true;
  const modelText =
    !bounded || bounded.truncated
      ? `${truncateSanitizedExternalContent(source, 19_988).text}\n[truncated]`
      : bounded.text;
  return { text: wrapExternalContent(modelText, { source: "api" }), truncated };
}
