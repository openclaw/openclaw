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
  const search = `https://www.google.com/search?${new URLSearchParams({ q: trimmed })}`;
  if (/^https?:\/\//i.test(trimmed)) {
    return normalizeBrowserUrlDraft(trimmed) ?? search;
  }
  if (EXPLICIT_SCHEME.test(trimmed)) {
    // Text with spaces is a query even when it starts like "note: ...".
    return /\s/.test(trimmed) ? search : null;
  }
  // The host part decides, so spaces in a path or query keep the address.
  const host = trimmed.split(/[/?#]/, 1)[0] ?? "";
  if (!/\s/.test(host)) {
    const parsed = URL.parse(`https://${trimmed}`);
    // A bare word ("openclaw") is a search; hosts with a dot, a port,
    // localhost or an IPv6 literal stay addresses, as they were before. The
    // port is read from the typed text: URL parsing drops the https default.
    if (
      parsed &&
      (parsed.hostname.includes(".") ||
        parsed.hostname === "localhost" ||
        parsed.hostname.startsWith("[") ||
        /:\d+$/.test(host))
    ) {
      return parsed.toString();
    }
  }
  return search;
}

/**
 * The address a bare name such as "devbox" or "devbox/path" opened before
 * address-bar search: text the URL-only normalizer accepts but the resolver
 * now searches. The address bar offers it as a "Go to" option.
 */
export function bareNameAddress(raw: string): string | null {
  // Only a single host label qualifies. Browser URL parsers accept spaces in
  // a host ("a b" becomes "https://a%20b/"), so the normalizer alone would
  // offer "Go to" for ordinary search phrases.
  const host = raw.trim().split(/[/?#]/, 1)[0] ?? "";
  if (!/^[\p{L}\p{N}_-]+$/u.test(host)) {
    return null;
  }
  const url = normalizeBrowserUrlDraft(raw);
  return url && url !== resolveBrowserAddressInput(raw) ? url : null;
}

/**
 * Chrome's own pages (chrome://settings, chrome://password-manager) typed by the operator.
 * The Gateway decides which ones the operator may open; the agent never can.
 */
export function normalizeChromePageUrlDraft(raw: string): string | null {
  const parsed = URL.parse(raw.trim());
  return parsed?.protocol === "chrome:" && parsed.host ? parsed.href : null;
}
