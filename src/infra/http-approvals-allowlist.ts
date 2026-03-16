/**
 * URL-based allowlist matching for HTTP/fetch tool approvals.
 *
 * Patterns are glob-style matches against normalized URLs.
 * Examples:
 *   - "https://api.example.com/**"        matches any path under api.example.com
 *   - "https://*.example.com/**"          matches any subdomain of example.com
 *   - "https://example.com/api/v1/*"      matches one path segment under /api/v1/
 *   - "https://example.com/exact"         matches exactly that URL
 *   - "*://example.com/**"                matches any protocol
 *
 * Glob semantics:
 *   - `*`  matches any characters except `/`
 *   - `**` matches any characters including `/`
 *   - `?`  matches a single character except `/`
 *
 * Matching is case-insensitive for the host portion. Path matching is also
 * case-insensitive to keep the behavior simple and predictable.
 */

import type { HttpAllowlistEntry } from "./http-approvals.js";

const GLOB_REGEX_CACHE_LIMIT = 512;
const globRegexCache = new Map<string, RegExp>();

function escapeRegExpLiteral(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileUrlGlobRegex(pattern: string): RegExp {
  const cached = globRegexCache.get(pattern);
  if (cached) {
    return cached;
  }

  let regex = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      const next = pattern[i + 1];
      if (next === "*") {
        regex += ".*";
        i += 2;
        continue;
      }
      regex += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      regex += "[^/]";
      i += 1;
      continue;
    }
    regex += escapeRegExpLiteral(ch);
    i += 1;
  }
  regex += "$";

  const compiled = new RegExp(regex, "i");
  if (globRegexCache.size >= GLOB_REGEX_CACHE_LIMIT) {
    globRegexCache.clear();
  }
  globRegexCache.set(pattern, compiled);
  return compiled;
}

function normalizeUrlForMatch(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    // Keep protocol, lowercase host, path, and search params.
    // Drop fragment since it is not sent to servers.
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

/**
 * Normalize a host-only pattern so it matches any path.
 * For example, `https://api.example.com` becomes `https://api.example.com/**`
 * because URL normalization always adds at least a trailing `/` to host-only URLs.
 */
function normalizePatternForHostOnlyMatch(pattern: string): string {
  // Check if the pattern looks like a full URL (protocol + host) with no path.
  // A host-only pattern ends right after the host portion with no `/` after `://`.
  const protocolEnd = pattern.indexOf("://");
  if (protocolEnd === -1) {
    return pattern;
  }
  const afterProtocol = pattern.slice(protocolEnd + 3);
  // If there's no `/` after the host, append `/**` to match any path.
  if (!afterProtocol.includes("/")) {
    return `${pattern}/**`;
  }
  return pattern;
}

function matchesUrlPattern(normalizedUrl: string, pattern: string): boolean {
  const lowerUrl = normalizedUrl.toLowerCase();
  const lowerPattern = normalizePatternForHostOnlyMatch(pattern.toLowerCase().trim());
  if (!lowerPattern) {
    return false;
  }
  return compileUrlGlobRegex(lowerPattern).test(lowerUrl);
}

/**
 * Match a URL against the allowlist. Returns the first matching entry or null.
 */
export function matchHttpAllowlist(
  allowlist: readonly HttpAllowlistEntry[],
  url: string,
): HttpAllowlistEntry | null {
  if (!allowlist || allowlist.length === 0) {
    return null;
  }
  const normalized = normalizeUrlForMatch(url);
  if (!normalized) {
    return null;
  }
  for (const entry of allowlist) {
    const pattern = entry.pattern?.trim();
    if (!pattern) {
      continue;
    }
    // Bare wildcard matches any URL
    if (pattern === "*" || pattern === "**") {
      return entry;
    }
    if (matchesUrlPattern(normalized, pattern)) {
      return entry;
    }
  }
  return null;
}

export type HttpAllowlistEvaluation = {
  allowlistSatisfied: boolean;
  matchedEntry: HttpAllowlistEntry | null;
};

export function evaluateHttpAllowlist(params: {
  url: string;
  allowlist: readonly HttpAllowlistEntry[];
}): HttpAllowlistEvaluation {
  const match = matchHttpAllowlist(params.allowlist, params.url);
  return {
    allowlistSatisfied: match !== null,
    matchedEntry: match,
  };
}
