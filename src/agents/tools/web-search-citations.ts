import { isRecord } from "@openclaw/normalization-core/record-coerce";

export const WEB_SEARCH_OUTPUT_MAX_CHARS = 20_000;
const WEB_SEARCH_CITATION_MAX_COUNT = 20;
const WEB_SEARCH_CITATION_MAX_SCAN = 1_000;

// Canonical URLs cannot carry readable prose outside the untrusted-content envelope.
export function toWebSearchHttpUrl(value: string): string | undefined {
  if (value.length > 2_048) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.href.length <= 2_048
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function consumeWebSearchUrlBudget(
  url: string,
  budget: { remaining: number; truncated: boolean },
): boolean {
  if (url.length > budget.remaining) {
    budget.truncated = true;
    return false;
  }
  budget.remaining -= url.length;
  return true;
}

/** Selects citations before enrichment using the same limits as web-search output. */
export function selectWebSearchCitations(value: unknown): {
  citations: Array<{ url: string; title?: string }> | undefined;
  remainingChars: number;
  truncated: boolean;
} {
  const budget = { remaining: WEB_SEARCH_OUTPUT_MAX_CHARS, truncated: false };
  if (!Array.isArray(value)) {
    return { citations: undefined, remainingChars: budget.remaining, truncated: false };
  }
  const citations: Array<{ url: string; title?: string }> = [];
  let scanned = 0;
  // A citation url must actually parse as http(s); free text in a url slot
  // would bypass the untrusted-content envelope.
  for (const entry of value) {
    if (
      ++scanned > WEB_SEARCH_CITATION_MAX_SCAN ||
      citations.length >= WEB_SEARCH_CITATION_MAX_COUNT
    ) {
      budget.truncated = true;
      break;
    }
    if (typeof entry === "string") {
      const url = toWebSearchHttpUrl(entry);
      if (url && consumeWebSearchUrlBudget(url, budget)) {
        citations.push({ url });
      }
      continue;
    }
    const url =
      isRecord(entry) && typeof entry.url === "string" ? toWebSearchHttpUrl(entry.url) : undefined;
    if (!isRecord(entry) || !url || !consumeWebSearchUrlBudget(url, budget)) {
      continue;
    }
    const citation: { url: string; title?: string } = { url };
    if (typeof entry.title === "string") {
      citation.title = entry.title;
    }
    citations.push(citation);
  }
  return { citations, remainingChars: budget.remaining, truncated: budget.truncated };
}
