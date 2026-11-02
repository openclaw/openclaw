import { findMarkdownLinkSourceSpans } from "../../../packages/markdown-core/src/link-spans.js";
import type { McpConnectAction } from "../../agents/mcp-connect-action.js";
import { copyReplyPayloadMetadata, isReplyPayloadTerminalContent } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";

const HTTP_URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gu;

function stripModelAuthorizationLinks(text: string, authorizationUrl: string): string {
  const current = new URL(authorizationUrl);
  const matches = (raw: string) => {
    const url = URL.parse(raw.replace(/\\&/gu, "&").replace(/&amp;/gu, "&"));
    return (
      url?.origin === current.origin &&
      url.pathname === current.pathname &&
      url.searchParams.get("client_id") === current.searchParams.get("client_id")
    );
  };
  const containsAuthorizationLink = (value: string) =>
    [...value.matchAll(HTTP_URL_PATTERN)].some(([url]) => matches(url));
  if (!containsAuthorizationLink(text)) {
    return text;
  }
  // Remove whole Markdown links (including their labels/titles) before bare
  // URLs, so a model-echoed URL cannot survive as a clickable label or title.
  const chunks: string[] = [];
  let cursor = 0;
  for (const [start, end] of findMarkdownLinkSourceSpans(text)) {
    chunks.push(text.slice(cursor, start));
    const link = text.slice(start, end);
    if (!containsAuthorizationLink(link)) {
      chunks.push(link);
    }
    cursor = end;
  }
  chunks.push(text.slice(cursor));
  return chunks
    .join("")
    .replace(HTTP_URL_PATTERN, (url) => (matches(url) ? "" : url))
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function isEligibleTerminalPayload(payload: ReplyPayload): boolean {
  return Boolean(
    payload.text?.trim() && payload.isError !== true && isReplyPayloadTerminalContent(payload),
  );
}

export function attachMcpConnectChannelAction(params: {
  payloads: ReplyPayload[];
  action?: McpConnectAction;
}): ReplyPayload[] {
  if (!params.action) {
    return params.payloads;
  }
  const index = params.payloads.findLastIndex(isEligibleTerminalPayload);
  if (index < 0) {
    return params.payloads;
  }
  const block = {
    type: "buttons" as const,
    buttons: [
      {
        label: `Connect ${params.action.serverName}`,
        action: { type: "url" as const, url: params.action.authorizationUrl },
      },
    ],
  };
  const { authorizationUrl } = params.action;
  const payloads = params.payloads.slice();
  const payload = payloads[index]!;
  payloads[index] = copyReplyPayloadMetadata(payload, {
    ...payload,
    presentation: payload.presentation
      ? { ...payload.presentation, blocks: [...payload.presentation.blocks, block] }
      : { blocks: [block] },
  });
  // The current tool action owns the sign-in URL. Sanitize every terminal
  // text chunk, not just the chunk carrying its channel button/fallback.
  return payloads.map((entry) => {
    if (!entry.text || entry.isError || !isReplyPayloadTerminalContent(entry)) {
      return entry;
    }
    const text = stripModelAuthorizationLinks(entry.text, authorizationUrl);
    return text === entry.text ? entry : copyReplyPayloadMetadata(entry, { ...entry, text });
  });
}
