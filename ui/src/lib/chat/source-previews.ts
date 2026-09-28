import { isHttpUrl } from "@openclaw/net-policy/url-protocol";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { Token } from "markdown-it";
import {
  isToolCallContentType,
  isToolResultContentType,
  resolveToolUseId,
} from "../../../../src/chat/tool-content.js";
import { resolveControlUiPaths } from "../../app/browser.ts";
import { parseGitHubLinkTarget } from "../../components/github-link-target.ts";
import { createMarkdownParser } from "../../components/markdown-parser.ts";
import { parseLocalMarkdownSessionUrl } from "../../components/markdown-session-links.ts";
import { normalizeMarkdownLineBreaks } from "../../components/markdown-text.ts";
import { transcriptRunId } from "../../pages/chat/chat-thread-run-identity.ts";
import { buildToolStreamIdentity } from "../../pages/chat/tool-stream-identity.ts";
import type { MessageGroup, ToolCard } from "./chat-types.ts";
import { extractTextCached } from "./message-extract.ts";
import { normalizeRoleForGrouping } from "./message-normalizer.ts";
import { extractToolCardsCached, resolveToolCardOutcome } from "./tool-cards.ts";

export type ChatSourcePreview = {
  url: string;
  title: string;
  domain: string;
  excerpt?: string;
  excerptKind?: "search" | "page";
};

type WebToolName = "web_search" | "web_fetch";
const MAX_SOURCES = 8;
const MAX_TEXT_CHARS = 30_000;
const MAX_SOURCE_FIELD_CHARS = 100_000;
const MAX_EXCERPT_CHARS = 280;
const parser = createMarkdownParser();
type SourceCandidate = {
  url: URL;
  name: WebToolName;
  title: unknown;
  excerpt: unknown;
};
type SourceCandidates = {
  source: SourceCandidate;
  page?: SourceCandidate;
  search?: SourceCandidate;
};
type PreviewCache = {
  text: string;
  links: string[];
  inputs: unknown[];
  previews: ChatSourcePreview[];
};
const previewsByAnswer = new WeakMap<object, PreviewCache>();

function webToolName(value: unknown): WebToolName | undefined {
  return value === "web_search" || value === "web_fetch" ? value : undefined;
}

function sourceUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length > 2_048 || !isHttpUrl(value)) {
    return null;
  }
  const url = new URL(value);
  return url.username || url.password ? null : url;
}

function sourceKey(url: URL): string {
  const key = new URL(url);
  key.hash = "";
  return key.href;
}

function inlineText(tokens: readonly Token[]): string {
  return tokens
    .map((token) => {
      if (token.type === "text" || token.type === "code_inline") {
        return token.content;
      }
      return token.type === "softbreak" || token.type === "hardbreak" ? " " : "";
    })
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
}

function markdownTokens(text: string): Token[] {
  return parser.parse(normalizeMarkdownLineBreaks(text), {});
}

// Remove only the boundary-owned frame, never a marker quoted inside source prose.
// Fetch spills append a diagnostic after the closing marker; it is not page content.
function sourceProse(value: unknown, name: WebToolName): string | undefined {
  if (typeof value !== "string" || value.length > MAX_SOURCE_FIELD_CHARS) {
    return undefined;
  }
  const source = name === "web_search" ? "Web Search" : "Web Fetch";
  const frame =
    /(?:^|\n)<<<EXTERNAL_UNTRUSTED_CONTENT id="([a-f0-9]{16})">>>\r?\nSource: ([^\r\n]+)\r?\n---\r?\n([\s\S]*?)\r?\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="\1">>>/u.exec(
      value,
    );
  return frame?.[2] === source
    ? truncateUtf16Safe(frame[3]?.trim() ?? "", MAX_TEXT_CHARS) || undefined
    : undefined;
}

function sourceTitle(value: unknown, name: WebToolName): string | undefined {
  const prose = sourceProse(value, name);
  if (!prose) {
    return undefined;
  }
  const text = markdownTokens(prose)
    .filter((token) => token.type === "inline")
    .map((token) => inlineText(token.children ?? []))
    .join(" ")
    .trim();
  return text ? truncateUtf16Safe(text, 180) : undefined;
}

function sourceExcerpt(value: unknown, name: WebToolName): string | undefined {
  const prose = sourceProse(value, name);
  if (!prose) {
    return undefined;
  }
  const tokens = markdownTokens(prose);
  const paragraphs = tokens.flatMap((token, index) =>
    token.type === "inline" &&
    tokens[index - 1]?.type === "paragraph_open" &&
    (name === "web_search" || tokens[index - 1]?.level === 0)
      ? [inlineText(token.children ?? [])]
      : [],
  );
  // A page heading or navigation label is not a useful excerpt. Search snippets
  // may legitimately be short; page previews need a readable paragraph.
  const text = paragraphs.find((paragraph) => paragraph.length >= (name === "web_fetch" ? 60 : 1));
  if (!text) {
    return undefined;
  }
  return text.length > MAX_EXCERPT_CHARS
    ? `${truncateUtf16Safe(text, MAX_EXCERPT_CHARS - 1).trimEnd()}…`
    : text;
}

function readPayload(card: ToolCard): Record<string, unknown> | null {
  if (card.details !== undefined) {
    return asNullableRecord(card.details);
  }
  if (!card.outputText || card.outputText.length > 100_000) {
    return null;
  }
  try {
    return asNullableRecord(JSON.parse(card.outputText));
  } catch {
    return null;
  }
}

function readSourceCandidates(
  card: ToolCard,
  name: WebToolName,
  cited: ReadonlySet<string>,
): Array<{ candidate: SourceCandidate; keys: string[] }> {
  const payload = readPayload(card);
  const external = asNullableRecord(payload?.externalContent);
  if (
    !payload ||
    external?.source !== name ||
    external.untrusted !== true ||
    external.wrapped !== true
  ) {
    return [];
  }
  const candidate = (
    url: URL,
    row: Record<string, unknown>,
    excerptField?: string,
    keys = [sourceKey(url)],
  ) => {
    if (!keys.some((key) => cited.has(key))) {
      return [];
    }
    return [
      {
        candidate: {
          url,
          name,
          title: row.title,
          excerpt: excerptField ? row[excerptField] : undefined,
        },
        keys,
      },
    ];
  };
  if (name === "web_search") {
    // Provider answer text combines citations; it cannot be assigned to any one page.
    const rows =
      payload.kind === "results"
        ? payload.results
        : payload.kind === "answer"
          ? payload.citations
          : undefined;
    if (!Array.isArray(rows)) {
      return [];
    }
    return rows.slice(0, 20).flatMap((value) => {
      const row = asNullableRecord(value);
      const url = sourceUrl(row?.url);
      return row && url
        ? candidate(url, row, payload.kind === "results" ? "snippet" : undefined)
        : [];
    });
  }
  if (typeof payload.status !== "number" || payload.status < 200 || payload.status >= 300) {
    return [];
  }
  const requested = sourceUrl(payload.url);
  const final = sourceUrl(payload.finalUrl);
  return requested && final
    ? candidate(final, payload, "text", [...new Set([sourceKey(requested), sourceKey(final)])])
    : [];
}

function renderSourcePreview(candidates: SourceCandidates): ChatSourcePreview {
  const source = candidates.source;
  const pageExcerpt = candidates.page && sourceExcerpt(candidates.page.excerpt, "web_fetch");
  const excerpt =
    pageExcerpt || (candidates.search && sourceExcerpt(candidates.search.excerpt, "web_search"));
  return {
    url: source.url.href,
    title: sourceTitle(source.title, source.name) ?? source.url.hostname,
    domain: source.url.hostname,
    ...(excerpt
      ? { excerpt, excerptKind: pageExcerpt ? ("page" as const) : ("search" as const) }
      : {}),
  };
}

/** Projects completed web results from one existing run frame; never fetches source content. */
export function extractChatSourcePreviews(params: {
  groups: readonly MessageGroup[];
  answer: unknown;
  runId: string;
  basePath?: string;
  sessionPublicOrigin?: string;
}): ChatSourcePreview[] {
  const answer = asNullableRecord(params.answer);
  if (!answer || transcriptRunId(answer) !== params.runId) {
    return [];
  }
  const answerText = extractTextCached(params.answer);
  if (!answerText || answerText.length > MAX_TEXT_CHARS) {
    return [];
  }
  const cached = previewsByAnswer.get(answer);
  const links =
    cached?.text === answerText
      ? cached.links
      : markdownTokens(answerText).flatMap((token) =>
          (token.children ?? []).flatMap((child) => {
            const url = child.type === "link_open" ? sourceUrl(child.attrGet("href")) : null;
            return url ? [sourceKey(url)] : [];
          }),
        );
  if (cached?.text !== answerText) {
    previewsByAnswer.set(answer, { text: answerText, links, inputs: [], previews: [] });
  }
  if (links.length === 0) {
    return [];
  }
  // Message/text caches treat messages as immutable. Tool cards can receive
  // projected outcomes, so snapshot their display fields as well as identity.
  const basePath = params.basePath ?? resolveControlUiPaths(globalThis.location.pathname)[0];
  const inputs: unknown[] = [
    params.runId,
    basePath,
    params.sessionPublicOrigin,
    globalThis.location.origin,
  ];
  const messages: Record<string, unknown>[] = [];
  let inFrame = false;
  frameInputs: for (const group of params.groups) {
    inputs.push(group.runId);
    if (group.runId !== params.runId) {
      continue;
    }
    for (const { message } of group.messages) {
      inputs.push(message);
      if (message === answer) {
        inFrame = true;
        break frameInputs;
      }
      const record = asNullableRecord(message);
      if (!record) {
        continue;
      }
      messages.push(record);
      inputs.push(
        record.role,
        record.toolName,
        record.tool_name,
        record.content,
        transcriptRunId(record),
      );
      for (const card of extractToolCardsCached(record)) {
        inputs.push(
          card,
          card.callId,
          card.runId,
          card.name,
          card.completed,
          card.live,
          card.isError,
          card.outputText,
          card.details,
        );
      }
    }
  }
  if (!inFrame) {
    return [];
  }
  if (
    cached?.text === answerText &&
    inputs.length === cached.inputs.length &&
    inputs.every((value, index) => Object.is(value, cached.inputs[index]))
  ) {
    return cached.previews;
  }
  const cited = new Set(links);
  const sources = new Map<string, SourceCandidates>();
  const redirects = new Map<string, string>();
  const callNames = new Map<string, string>();
  for (const record of messages) {
    const role = typeof record.role === "string" ? normalizeRoleForGrouping(record.role) : "";
    if ((role !== "assistant" && role !== "tool") || transcriptRunId(record) !== params.runId) {
      continue;
    }
    const blocks = Array.isArray(record.content) ? record.content : [];
    if (
      blocks.some((value) => {
        const block = asNullableRecord(value);
        const blockRunId = readNonBlankString(block?.runId);
        return (
          block &&
          (isToolCallContentType(block.type) || isToolResultContentType(block.type)) &&
          blockRunId &&
          blockRunId !== params.runId
        );
      })
    ) {
      continue;
    }
    const envelopeName =
      readNonBlankString(record.toolName) ?? readNonBlankString(record.tool_name);
    for (const value of blocks) {
      const block = asNullableRecord(value);
      const id =
        block && isToolCallContentType(block.type)
          ? (resolveToolUseId(block) ?? readNonBlankString(record.toolCallId))
          : undefined;
      const name = readNonBlankString(block?.name);
      if (id && name) {
        callNames.set(buildToolStreamIdentity(params.runId, id), name);
      }
    }
    for (const card of extractToolCardsCached(record)) {
      if (card.runId !== params.runId || resolveToolCardOutcome(card, false) !== "succeeded") {
        continue;
      }
      const callName = card.callId
        ? callNames.get(buildToolStreamIdentity(params.runId, card.callId))
        : undefined;
      const name = webToolName(callName ?? envelopeName);
      if (!name || card.name !== name || (envelopeName && envelopeName !== name)) {
        continue;
      }
      for (const { candidate, keys } of readSourceCandidates(card, name, cited)) {
        const canonicalKey = sourceKey(candidate.url);
        const candidates: SourceCandidates = sources.get(canonicalKey) ?? { source: candidate };
        if (name === "web_fetch") {
          candidates.source = candidate;
          candidates.page = candidate;
          candidates.search ??= keys
            .map((key) => sources.get(key)?.search)
            .find((search) => search !== undefined);
          // Track observed destinations so later refreshes apply even when only
          // the original URL was cited. A successful final URL ends its old redirect.
          cited.add(canonicalKey);
          for (const key of keys) {
            if (key !== canonicalKey) {
              redirects.set(key, canonicalKey);
            }
          }
          redirects.delete(canonicalKey);
        } else if (!candidates.search?.excerpt) {
          candidates.search = candidate;
          if (!candidates.page) {
            candidates.source = candidate;
          }
        }
        sources.set(canonicalKey, candidates);
      }
    }
  }
  const previews = new Map<string, ChatSourcePreview>();
  const hasDedicatedCard = (href: string) =>
    parseGitHubLinkTarget(href) !== null ||
    parseLocalMarkdownSessionUrl(href, { basePath, publicOrigin: params.sessionPublicOrigin }) !==
      null;
  for (const link of links) {
    if (hasDedicatedCard(link)) {
      continue;
    }
    let canonicalKey = link;
    for (let next = redirects.get(canonicalKey); next; next = redirects.get(canonicalKey)) {
      canonicalKey = next;
    }
    const source = sources.get(canonicalKey);
    if (source && !previews.has(canonicalKey) && !hasDedicatedCard(canonicalKey)) {
      previews.set(canonicalKey, renderSourcePreview(source));
    }
    if (previews.size >= MAX_SOURCES) {
      break;
    }
  }
  const result = [...previews.values()];
  previewsByAnswer.set(answer, { text: answerText, links, inputs, previews: result });
  return result;
}
