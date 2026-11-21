import { truncateSanitizedExternalContent, wrapWebContent } from "../security/external-content.js";
import { isRecord, truncateUtf16Safe } from "./string-coerce-runtime.js";

export type ResponsesSearchResponse = {
  output?: Array<{
    type?: string;
    text?: string;
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{
        type?: string;
        url?: string;
      } | null>;
    } | null>;
    annotations?: Array<{
      type?: string;
      url?: string;
    } | null>;
  } | null>;
  output_text?: string;
  citations?: string[];
  inline_citations?: Array<{
    start_index: number;
    end_index: number;
    url: string;
  }>;
};

const CITATION_MAX_COUNT = 20;
const CITATION_MAX_SCAN = 1_000;
const CITATION_URL_MAX_CHARS = 2_048;

function normalizeCitationUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > CITATION_URL_MAX_CHARS) {
    return undefined;
  }
  const url = URL.parse(value);
  if (
    !url ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.href.length > CITATION_URL_MAX_CHARS
  ) {
    return undefined;
  }
  return url.href === `${value}/` ? value : url.href;
}

function collectUrlCitations(annotations: unknown, citations: Set<string>): void {
  if (!Array.isArray(annotations)) {
    return;
  }
  let scanned = 0;
  for (const annotation of annotations) {
    if (++scanned > CITATION_MAX_SCAN || citations.size >= CITATION_MAX_COUNT) {
      break;
    }
    if (!isRecord(annotation) || annotation.type !== "url_citation") {
      continue;
    }
    const url = normalizeCitationUrl(annotation.url);
    if (url) {
      citations.add(url);
    }
  }
}

/** Authentication, model/tool qualification and transport belong to the caller. */
export function buildResponsesSearchRequest(params: {
  model: string;
  inputText: string;
  tools: Array<Record<string, unknown>>;
  maxTurns?: number;
  reasoningEffort?: string;
}): Record<string, unknown> {
  return {
    model: params.model,
    input: [{ role: "user", content: params.inputText }],
    tools: params.tools,
    store: false,
    ...(params.reasoningEffort ? { reasoning: { effort: params.reasoningEffort } } : {}),
    ...(params.maxTurns ? { max_turns: params.maxTurns } : {}),
  };
}

export function requireResponsesSearchTextAndCitations(
  data: ResponsesSearchResponse,
  label: string,
  maxContentChars?: number,
): {
  content: string;
  citations: string[];
  truncated?: true;
  retainedRawChars?: number;
  inlineCitationOffsetsSafe?: false;
} {
  const textParts: string[] = [];
  const pendingAnnotations: Array<{ rawOffset: number; annotations: unknown }> = [];
  let remainingRawChars = maxContentChars;
  let completeRawPrefix = true;
  let truncated = false;
  let rawOffset = 0;
  for (const output of data.output ?? []) {
    if (!isRecord(output)) {
      continue;
    }
    const blocks =
      output.type === "message" && Array.isArray(output.content)
        ? output.content
        : output.type === "output_text"
          ? [output]
          : [];
    for (const block of blocks) {
      if (!isRecord(block) || block.type !== "output_text" || typeof block.text !== "string") {
        continue;
      }
      if (block.text) {
        const blockRawOffset = rawOffset;
        rawOffset += block.text.length;
        const text =
          remainingRawChars === undefined
            ? block.text
            : completeRawPrefix
              ? truncateUtf16Safe(block.text, remainingRawChars)
              : "";
        if (text.length < block.text.length) {
          truncated = true;
          completeRawPrefix = false;
        }
        if (text) {
          textParts.push(text);
          if (remainingRawChars !== undefined) {
            remainingRawChars -= text.length;
          }
          if (Array.isArray(block.annotations)) {
            pendingAnnotations.push({ rawOffset: blockRawOffset, annotations: block.annotations });
          }
        }
      }
    }
  }

  // Match the Responses SDK: adjacent output text blocks have no separator.
  const rawText =
    textParts.join("") || (typeof data.output_text === "string" ? data.output_text : "");
  let text = rawText;
  let retainedRawChars = rawText.length;
  if (maxContentChars !== undefined) {
    const bounded = truncateSanitizedExternalContent(rawText, maxContentChars);
    text = bounded.text;
    truncated ||= bounded.truncated;
    retainedRawChars = bounded.retainedRawChars;
  }
  if (!text) {
    throw new Error(`${label}: no answer text returned; try a simpler request`);
  }
  const citations = new Set<string>();
  if (Array.isArray(data.citations)) {
    let scanned = 0;
    for (const citation of data.citations) {
      if (++scanned > CITATION_MAX_SCAN || citations.size >= CITATION_MAX_COUNT) {
        break;
      }
      const url = normalizeCitationUrl(citation);
      if (url) {
        citations.add(url);
      }
    }
  }
  if (citations.size === 0) {
    for (const annotation of pendingAnnotations) {
      if (annotation.rawOffset < retainedRawChars) {
        collectUrlCitations(annotation.annotations, citations);
      }
    }
  }
  const inlineCitationOffsetsSafe = text === rawText.slice(0, retainedRawChars);
  return {
    content: text,
    citations: [...citations],
    ...(truncated ? { truncated: true } : {}),
    ...(maxContentChars === undefined ? {} : { retainedRawChars }),
    ...(inlineCitationOffsetsSafe ? {} : { inlineCitationOffsetsSafe: false as const }),
  };
}

export function requireResponsesSearchTextCitationsAndInline(
  data: ResponsesSearchResponse,
  label: string,
  inlineCitationsEnabled: boolean,
  maxContentChars?: number,
): {
  content: string;
  citations: string[];
  inlineCitations?: ResponsesSearchResponse["inline_citations"];
  truncated?: true;
} {
  const { content, citations, truncated, retainedRawChars, inlineCitationOffsetsSafe } =
    requireResponsesSearchTextAndCitations(data, label, maxContentChars);
  const inlineCitations =
    inlineCitationsEnabled && Array.isArray(data.inline_citations)
      ? data.inline_citations.slice(0, CITATION_MAX_COUNT).flatMap((citation) => {
          if (!isRecord(citation)) {
            return [];
          }
          const url = normalizeCitationUrl(citation.url);
          return inlineCitationOffsetsSafe !== false &&
            url &&
            Number.isSafeInteger(citation.start_index) &&
            Number.isSafeInteger(citation.end_index) &&
            citation.start_index >= 0 &&
            citation.end_index >= citation.start_index &&
            citation.end_index <= (retainedRawChars ?? content.length)
            ? [{ start_index: citation.start_index, end_index: citation.end_index, url }]
            : [];
        })
      : undefined;
  return {
    content,
    citations,
    inlineCitations,
    ...(truncated ? { truncated: true } : {}),
  };
}

export function buildResponsesSearchPayload(params: {
  query: string;
  provider: string;
  model: string;
  tookMs: number;
  content: string;
  citations: string[];
  inlineCitations?: ResponsesSearchResponse["inline_citations"];
  truncated?: boolean;
  source?: "web_search" | "x_search";
}): Record<string, unknown> {
  return {
    query: params.query,
    provider: params.provider,
    model: params.model,
    tookMs: params.tookMs,
    externalContent: {
      untrusted: true,
      source: params.source ?? "web_search",
      provider: params.provider,
      wrapped: true,
    },
    content: wrapWebContent(params.content, "web_search"),
    citations: params.citations,
    ...(params.inlineCitations ? { inlineCitations: params.inlineCitations } : {}),
    ...(params.truncated ? { truncated: true } : {}),
  };
}
