// A colon followed by digits is a port, not a scheme.
const EXPLICIT_SCHEME = /^[a-z][a-z0-9+.-]*:(?![0-9])/i;

export function normalizeBrowserUrlDraft(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const hasExplicitScheme = EXPLICIT_SCHEME.test(trimmed);
  if (hasExplicitScheme && !/^https?:\/\//i.test(trimmed)) {
    return null;
  }
  const candidate = hasExplicitScheme ? trimmed : `https://${trimmed}`;
  const parsed = URL.parse(candidate);
  return parsed && (parsed.protocol === "http:" || parsed.protocol === "https:")
    ? parsed.toString()
    : null;
}

/**
 * Resolves address-bar text the way a browser omnibox does: addresses open
 * as before, anything else becomes a search. Returns null only for empty text
 * or a non-web scheme (javascript:, file:, ...), which the panel reports.
 *
 * Google is used because no browser the panel drives exposes its default
 * search engine over a supported API: CDP and Chrome DevTools MCP have no
 * omnibox or search-engine access, and WKWebView has no default engine. It
 * matches the default of a fresh managed `openclaw` profile in most regions.
 */
export function resolveBrowserAddressInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  // Text with spaces is a query even when it starts like "note: ...".
  if (!/\s/.test(trimmed)) {
    if (EXPLICIT_SCHEME.test(trimmed)) {
      return normalizeBrowserUrlDraft(trimmed);
    }
    const parsed = URL.parse(`https://${trimmed}`);
    // A bare word ("openclaw") is a search; hosts with a dot, a port,
    // localhost or an IPv6 literal stay addresses, as they were before.
    if (
      parsed &&
      (parsed.hostname.includes(".") ||
        parsed.hostname === "localhost" ||
        parsed.hostname.startsWith("[") ||
        parsed.port)
    ) {
      return parsed.toString();
    }
  }
  return `https://www.google.com/search?${new URLSearchParams({ q: trimmed })}`;
}
