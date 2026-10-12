// Link detection extracts unique safe bare HTTP(S) URLs from inbound text while filtering SSRF targets.
import { findMarkdownLinkSourceSpans } from "../../packages/markdown-core/src/link-spans.js";
import { isBlockedHostnameOrIp } from "../infra/net/ssrf.js";
import { DEFAULT_MAX_LINKS } from "./defaults.js";

const BARE_LINK_RE = /https?:\/\/\S+/gi;

// Prose delimiters that are trimmed off a bare link, mirroring the punctuation
// GitHub's GFM autolink extension excludes. Unlike GFM, trimming applies only to
// the path region: from a query or fragment delimiter onward every byte is treated
// as the authored URL value, so commas, periods and closing marks there are kept.
const TRAILING_PUNCTUATION = ",.;:?!\"'…";
// Closers are trailing punctuation only when unbalanced by their opener inside the
// path region, so destinations like https://en.wikipedia.org/wiki/Foo_(bar) keep
// their suffix. In the query or fragment region they are never trimmed, because an
// unmatched closer can still be part of an authored value that the URL parser keeps.
const UNPAIRED_CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{", ">": "<" };

function trimTrailingPunctuation(url: string): string {
  const delimiter = /[?#]/.exec(url);
  // Index one past the last character that prose trimming may remove.
  const pathEnd = delimiter ? delimiter.index : url.length;
  let end = url.length;
  while (end > 0 && end - 1 < pathEnd) {
    const last = url.slice(end - 1, end);
    const opener = UNPAIRED_CLOSERS[last];
    if (opener) {
      let opens = 0;
      let closes = 0;
      for (let i = 0; i < end; i += 1) {
        const char = url[i];
        if (char === opener) {
          opens += 1;
        } else if (char === last) {
          closes += 1;
        }
      }
      if (closes > opens) {
        end -= 1;
        continue;
      }
      break;
    }
    if (TRAILING_PUNCTUATION.includes(last)) {
      end -= 1;
      continue;
    }
    break;
  }
  return url.slice(0, end);
}

function stripMarkdownLinks(message: string): string {
  const chunks: string[] = [];
  let cursor = 0;
  for (const [start, end] of findMarkdownLinkSourceSpans(message)) {
    chunks.push(message.slice(cursor, start), " ");
    cursor = end;
  }
  chunks.push(message.slice(cursor));
  return chunks.join("");
}

function resolveMaxLinks(value?: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return DEFAULT_MAX_LINKS;
}

function isAllowedUrl(raw: string): boolean {
  const parsed = URL.parse(raw);
  return Boolean(
    parsed &&
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    !isBlockedHostnameOrIp(parsed.hostname),
  );
}

/**
 * Extracts unique, SSRF-filtered bare HTTP(S) links from inbound text.
 * Markdown links are ignored so display-only citations do not trigger fetches.
 */
export function extractLinksFromMessage(message: string, opts?: { maxLinks?: number }): string[] {
  const source = message?.trim();
  if (!source) {
    return [];
  }

  const maxLinks = resolveMaxLinks(opts?.maxLinks);
  const sanitized = stripMarkdownLinks(source);
  const seen = new Set<string>();
  const results: string[] = [];

  for (const match of sanitized.matchAll(BARE_LINK_RE)) {
    const raw = trimTrailingPunctuation(match[0]?.trim() ?? "");
    if (!raw) {
      continue;
    }
    if (!isAllowedUrl(raw)) {
      continue;
    }
    if (seen.has(raw)) {
      continue;
    }
    seen.add(raw);
    results.push(raw);
    if (results.length >= maxLinks) {
      break;
    }
  }

  return results;
}
