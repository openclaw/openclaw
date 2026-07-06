// Regex patterns for ANSI escape sequences (constructed from strings to
// satisfy the no-control-regex lint rule).
const SGR_PATTERN = "\\x1b\\[[0-9;]*m";
const OSC8_PATTERN = "\\x1b\\]8;;.*?(?:\\x07|\\x1b\\\\)";
const ANSI_RE = new RegExp(`${SGR_PATTERN}|${OSC8_PATTERN}`, "g");
const SGR_START_RE = new RegExp(`^${SGR_PATTERN}`);
const OSC8_START_RE = new RegExp(`^${OSC8_PATTERN}`);

/** Trim a trailing `)` from a bare URL only if it leaves parentheses unbalanced. */
function trimTrailingUnbalancedParen(url: string): string {
  if (!url.endsWith(")")) {
    return url;
  }
  let depth = 0;
  for (const char of url) {
    if (char === "(") {
      depth++;
    } else if (char === ")") {
      depth--;
    }
  }
  // A negative depth means there are more closing than opening parens; drop
  // trailing close parens that likely belong to surrounding markdown/text.
  let trimmed = url;
  while (depth < 0 && trimmed.endsWith(")")) {
    trimmed = trimmed.slice(0, -1);
    depth++;
  }
  return trimmed;
}

interface MarkdownLinkMatch {
  start: number;
  end: number;
  url: string;
}

/**
 * Find markdown link hrefs in text, respecting balanced parentheses inside the
 * URL so links like `[text](https://example.com/path_(note))` parse correctly.
 */
function findMarkdownLinkHrefs(text: string): MarkdownLinkMatch[] {
  const matches: MarkdownLinkMatch[] = [];
  let i = 0;
  while (i < text.length) {
    const openBracket = text.indexOf("[", i);
    if (openBracket === -1) {
      break;
    }
    const closeBracket = text.indexOf("]", openBracket + 1);
    if (closeBracket === -1) {
      break;
    }
    if (text[closeBracket + 1] !== "(") {
      i = openBracket + 1;
      continue;
    }
    const urlStart = closeBracket + 2;
    // Skip optional < ... > wrapper.
    let cursor = urlStart;
    let wrapped = false;
    if (text[cursor] === "<") {
      wrapped = true;
      cursor++;
    }
    if (!text.slice(cursor).startsWith("http://") && !text.slice(cursor).startsWith("https://")) {
      i = openBracket + 1;
      continue;
    }

    // Walk the URL, tracking paren depth, until we find the matching close paren.
    let depth = 0;
    let urlEnd = cursor;
    while (urlEnd < text.length) {
      const char = text[urlEnd];
      if (char === "(") {
        depth++;
      } else if (char === ")") {
        if (depth === 0) {
          break;
        }
        depth--;
      } else if (wrapped && char === ">" && depth === 0) {
        // For `<url>` wrappers, the URL ends at `>` and the close paren follows.
        urlEnd++;
        break;
      }
      urlEnd++;
    }

    if (urlEnd >= text.length || text[urlEnd] !== ")") {
      i = openBracket + 1;
      continue;
    }

    let rawUrl = text.slice(cursor, urlEnd);
    if (wrapped && rawUrl.endsWith(">")) {
      rawUrl = rawUrl.slice(0, -1);
    }
    // Strip optional title text that may appear between the URL and closing `)`.
    const trimmedUrl = stripMarkdownLinkTitle(rawUrl);
    matches.push({ start: openBracket, end: urlEnd + 1, url: trimmedUrl });
    i = urlEnd + 1;
  }
  return matches;
}

/** Remove a trailing markdown link title (e.g. `"title"` or `'title'`) from a URL. */
function stripMarkdownLinkTitle(rawUrl: string): string {
  const titleMatch = rawUrl.match(/\s+["'][^"']*["']\s*$/);
  if (titleMatch) {
    return rawUrl.slice(0, titleMatch.index).trimEnd();
  }
  return rawUrl;
}

/** Remove markdown links from text so bare-URL extraction does not double-match. */
function removeMarkdownLinks(text: string): string {
  let result = "";
  let lastEnd = 0;
  for (const match of findMarkdownLinkHrefs(text)) {
    result += text.slice(lastEnd, match.start);
    lastEnd = match.end;
  }
  result += text.slice(lastEnd);
  return result;
}

/**
 * Extract all unique URLs from raw markdown text.
 * Finds both bare URLs and markdown link hrefs [text](url).
 */
export function extractUrls(markdown: string): string[] {
  const urls = new Set<string>();

  // Markdown link hrefs: [text](url), with optional <...> and optional title.
  // Parse manually so URLs that contain balanced parentheses (e.g. Wikipedia
  // disambiguation pages) are kept intact instead of being truncated at the
  // first `)`.
  for (const { url } of findMarkdownLinkHrefs(markdown)) {
    urls.add(url);
  }

  // Bare URLs (remove markdown links first to avoid double-matching)
  const stripped = removeMarkdownLinks(markdown);
  const bareRe = /https?:\/\/[^\s\]>]+/g;
  let m: RegExpExecArray | null;
  while ((m = bareRe.exec(stripped)) !== null) {
    // Trim a trailing `)` only when it would leave the URL with unbalanced
    // parentheses, so bare URLs like `https://example.com/path)` stay valid.
    urls.add(trimTrailingUnbalancedParen(m[0]));
  }

  return [...urls];
}

/** Strip ANSI SGR and OSC 8 sequences to get visible text. */
function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, "");
}

interface UrlRange {
  start: number; // visible text start index
  end: number; // visible text end index (exclusive)
  url: string; // full URL to link to
}

/**
 * Find URL ranges in a line's visible text, handling cross-line URL splits.
 */
function findUrlRanges(
  visibleText: string,
  knownUrls: string[],
  pending: { url: string; consumed: number } | null,
): { ranges: UrlRange[]; pending: { url: string; consumed: number } | null } {
  const ranges: UrlRange[] = [];
  let newPending: { url: string; consumed: number } | null = null;
  let searchFrom = 0;

  // Handle continuation of a URL broken from the previous line
  if (pending) {
    const remaining = pending.url.slice(pending.consumed);
    const trimmed = visibleText.trimStart();
    const leadingSpaces = visibleText.length - trimmed.length;

    let matchLen = 0;
    for (let j = 0; j < remaining.length && j < trimmed.length; j++) {
      if (remaining[j] === trimmed[j]) {
        matchLen++;
      } else {
        break;
      }
    }

    if (matchLen > 0) {
      ranges.push({
        start: leadingSpaces,
        end: leadingSpaces + matchLen,
        url: pending.url,
      });
      searchFrom = leadingSpaces + matchLen;

      if (pending.consumed + matchLen < pending.url.length) {
        newPending = { url: pending.url, consumed: pending.consumed + matchLen };
      }
    }
  }

  // Find new URL starts in visible text
  const urlRe = /https?:\/\/[^\s)\]>]+/g;
  urlRe.lastIndex = searchFrom;
  let match: RegExpExecArray | null;

  while ((match = urlRe.exec(visibleText)) !== null) {
    const fragment = match[0];
    const start = match.index;

    // Resolve fragment to a known URL (exact > prefix > superstring)
    let resolvedUrl = fragment;
    let found = false;

    for (const known of knownUrls) {
      if (known === fragment) {
        resolvedUrl = known;
        found = true;
        break;
      }
    }
    if (!found) {
      let bestLen = 0;
      for (const known of knownUrls) {
        if (known.startsWith(fragment) && known.length > bestLen) {
          resolvedUrl = known;
          bestLen = known.length;
          found = true;
        }
      }
    }
    if (!found) {
      let bestLen = 0;
      for (const known of knownUrls) {
        if (fragment.startsWith(known) && known.length > bestLen) {
          resolvedUrl = known;
          bestLen = known.length;
        }
      }
    }

    ranges.push({ start, end: start + fragment.length, url: resolvedUrl });

    // If fragment is a strict prefix of the resolved URL, it may be split
    if (resolvedUrl.length > fragment.length && resolvedUrl.startsWith(fragment)) {
      newPending = { url: resolvedUrl, consumed: fragment.length };
    }
  }

  return { ranges, pending: newPending };
}

/**
 * Apply OSC 8 hyperlink sequences to a line based on visible-text URL ranges.
 * Walks through the raw string character by character, inserting OSC 8
 * open/close sequences at URL range boundaries while preserving ANSI codes.
 */
function applyOsc8Ranges(line: string, ranges: UrlRange[]): string {
  if (ranges.length === 0) {
    return line;
  }

  // Build a lookup: visible position → URL
  const urlAt = new Map<number, string>();
  for (const r of ranges) {
    for (let p = r.start; p < r.end; p++) {
      urlAt.set(p, r.url);
    }
  }

  let result = "";
  let visiblePos = 0;
  let activeUrl: string | null = null;
  let i = 0;

  while (i < line.length) {
    // Fast path: only check for escape sequences when we see ESC
    if (line.charCodeAt(i) === 0x1b) {
      // ANSI SGR sequence
      const sgr = line.slice(i).match(SGR_START_RE);
      if (sgr) {
        result += sgr[0];
        i += sgr[0].length;
        continue;
      }

      // Existing OSC 8 sequence (pass through)
      const osc = line.slice(i).match(OSC8_START_RE);
      if (osc) {
        result += osc[0];
        i += osc[0].length;
        continue;
      }
    }

    // Visible character — toggle OSC 8 at range boundaries
    const targetUrl = urlAt.get(visiblePos) ?? null;
    if (targetUrl !== activeUrl) {
      if (activeUrl !== null) {
        result += "\x1b]8;;\x07";
      }
      if (targetUrl !== null) {
        result += `\x1b]8;;${targetUrl}\x07`;
      }
      activeUrl = targetUrl;
    }

    result += line[i];
    visiblePos++;
    i++;
  }

  if (activeUrl !== null) {
    result += "\x1b]8;;\x07";
  }

  return result;
}

/**
 * Add OSC 8 hyperlinks to rendered lines using a pre-extracted URL list.
 *
 * For each line, finds URL-like substrings in the visible text, matches them
 * against known URLs, and wraps each fragment with OSC 8 escape sequences.
 * Handles URLs broken across multiple lines by pi-tui's word wrapping.
 */
export function addOsc8Hyperlinks(lines: string[], urls: string[]): string[] {
  if (urls.length === 0) {
    return lines;
  }

  let pending: { url: string; consumed: number } | null = null;

  return lines.map((line) => {
    const visible = stripAnsi(line);
    const result = findUrlRanges(visible, urls, pending);
    pending = result.pending;
    return applyOsc8Ranges(line, result.ranges);
  });
}
