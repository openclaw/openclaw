// Link detection extracts unique safe bare HTTP(S) URLs from inbound text while filtering SSRF targets.
import { findMarkdownLinkSourceSpans } from "../../packages/markdown-core/src/link-spans.js";
import { isBlockedHostnameOrIp } from "../infra/net/ssrf.js";
import { DEFAULT_MAX_LINKS } from "./defaults.js";

// First branch: an angle-bracketed URL is the literal form — its content is used
// verbatim and the brackets never reach the fetch. Second branch: a bare token.
const LINK_TOKEN_RE = /<(https?:\/\/[^\s<>]+)>|https?:\/\/\S+/gi;

// Prose delimiters that are trimmed off a bare link when they follow word characters,
// mirroring GitHub's GFM autolink extension behavior. Unlike GFM, trimming applies only
// when the punctuation follows the path region (not inside query/fragment).
const TRAILING_PUNCTUATION = ",.;:?!\"'…";
// Closers are trailing punctuation only when unbalanced by their opener inside the
// path region, so destinations like https://en.wikipedia.org/wiki/Foo_(bar) keep
// their suffix. In the query or fragment region they are never trimmed.
const UNPAIRED_CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{", ">": "<" };

/**
 * Trim trailing prose punctuation from a bare URL when the character before the
 * suffix is content a URL ends on — word character or path separator — including
 * stacked delimiters like "a)." and trailing-slash roots like "https://example.com/,"
 * and "(https://example.com/)". Balanced closers (Wikipedia-style "Foo_(bar)") and
 * everything from a query or fragment delimiter onward are authored values and
 * survive untouched. A destination that genuinely ends in punctuation must use the
 * angle-bracket literal form instead.
 */
function trimTrailingProsePunctuation(url: string): string {
  // Find where the path ends (before query or fragment)
  const delimiterIndex = /[?#]/.exec(url);
  const pathEnd = delimiterIndex ? delimiterIndex.index : url.length;

  // Collect the longest suffix of prose punctuation and unbalanced closers inside the
  // path region, then drop it based on the character immediately before. Deciding that
  // check once for the whole suffix is what lets stacked delimiters like "a)." and
  // trailing-slash roots like "/," trim together.
  let runStart = url.length;
  while (runStart > 1 && runStart - 1 < pathEnd) {
    const last = url[runStart - 1]!;

    const opener = UNPAIRED_CLOSERS[last];
    if (opener) {
      let opens = 0;
      let closes = 0;
      for (let i = 0; i < runStart; i += 1) {
        const char = url[i];
        if (char === opener) {
          opens += 1;
        } else if (char === last) {
          closes += 1;
        }
      }
      // Only trim if there are more closes than opens (unbalanced closer)
      if (closes > opens) {
        runStart -= 1;
        continue;
      }
      break;
    }

    if (TRAILING_PUNCTUATION.includes(last)) {
      runStart -= 1;
      continue;
    }

    break;
  }

  if (runStart === url.length) {
    return url;
  }
  // Trim when the character before the suffix is content a URL ends on: any
  // Unicode letter or digit (so accented or non-Latin paths like
  // "https://example.com/café," still shed the prose comma, not just ASCII),
  // a closer that stayed because it is balanced
  // ("(read https://example.com/Foo_(bar))" drops the outer ")" but keeps the
  // authored "(bar)"), or a path separator so trailing-slash URLs like
  // "https://example.com/, " and "(https://example.com/)" also shed the prose
  // delimiter.
  const before = url[runStart - 1]!;
  if (!/[\p{L}\p{N}_/]/u.test(before) && !(before in UNPAIRED_CLOSERS)) {
    return url;
  }
  return url.slice(0, runStart);
}

function stripMarkdownLinks(message: string): string {
  const chunks: string[] = [];
  let cursor = 0;
  for (const [start, end] of findMarkdownLinkSourceSpans(message)) {
    // mdast reports a bare <https://...> autolink as a link node too. Keep that
    // form intact: it is the authored literal destination the token scan reads.
    if (message[start] === "<") {
      continue;
    }
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
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    if (isBlockedHostnameOrIp(parsed.hostname)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Extracts unique, SSRF-filtered bare HTTP(S) links from inbound text.
 * Markdown links are ignored so display-only citations do not trigger fetches.
 *
 * Trims trailing prose punctuation (commas, periods, etc.) from bare URLs when
 * they appear after word content, matching GitHub's GFM autolink behavior.
 * Query/fragment regions are preserved verbatim.
 *
 * Use the angle-bracket form (<https://example.com/path!>) for a literal
 * destination whose trailing punctuation must survive; it is never trimmed and
 * the brackets never reach the fetch. Markdown link destinations are stripped
 * entirely and never fetched.
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

  for (const match of sanitized.matchAll(LINK_TOKEN_RE)) {
    const literal = match[1];
    const raw = literal ?? match[0]?.trim();
    if (!raw) {
      continue;
    }

    // Angle-bracket form is an authored literal destination; bare tokens get
    // their prose-ending punctuation trimmed, preserving intentional paths.
    const trimmed = literal ? raw : trimTrailingProsePunctuation(raw);

    if (!trimmed) {
      continue;
    }

    if (!isAllowedUrl(trimmed)) {
      continue;
    }
    if (seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    results.push(trimmed);
    if (results.length >= maxLinks) {
      break;
    }
  }

  return results;
}
