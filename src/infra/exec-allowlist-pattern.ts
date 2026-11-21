// Parses execution allowlist patterns for approval policy checks.
import path from "node:path";
import { safeRealpathSync } from "@openclaw/fs-safe/path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { escapeRegExp as escapeRegExpLiteral } from "../shared/regexp.js";
import { expandHomePrefix } from "./home-dir.js";

const GLOB_REGEX_CACHE_LIMIT = 512;
const globRegexCache = new Map<string, RegExp>();
const DOT_PATH_SEGMENT = /(?:^|[\\/])\.{1,2}(?![^\\/])/;
const WILDCARD = /[*?]/;
const WINDOWS_PREFIX = /^\\\\[?.]\\/;
const WINDOWS_SEPARATOR = /\\/g;

function normalizeMatchTarget(value: string): string {
  if (process.platform === "win32") {
    const stripped = value.replace(WINDOWS_PREFIX, "");
    return normalizeLowercaseStringOrEmpty(stripped.replace(WINDOWS_SEPARATOR, "/"));
  }
  // A POSIX filename may contain backslashes. Folding "\\" into "/" would
  // approve that file as a different allowlisted path. Windows separators
  // fold only on win32.
  if (process.platform === "darwin") {
    if (value === "/private/var") {
      return "/var";
    }
    if (value.startsWith("/private/var/")) {
      return value.slice("/private".length);
    }
  }
  return value;
}

function normalizeDotPathSegments(value: string): string {
  const normalized =
    process.platform === "win32" ? path.win32.normalize(value) : path.posix.normalize(value);
  return normalizeMatchTarget(normalized);
}

function compileGlobRegex(pattern: string): RegExp {
  const cacheKey = `${process.platform}:${pattern}`;
  const cached = globRegexCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const regex = pattern.replace(/\*\*|[*?]|[^*?]+/g, (token) => {
    switch (token) {
      case "**":
        return ".*";
      case "*":
        return "[^/]*";
      case "?":
        return "[^/]";
      default:
        return escapeRegExpLiteral(token);
    }
  });

  const compiled = new RegExp(`^${regex}$`, process.platform === "win32" ? "i" : "");
  if (globRegexCache.size >= GLOB_REGEX_CACHE_LIMIT) {
    globRegexCache.clear();
  }
  globRegexCache.set(cacheKey, compiled);
  return compiled;
}

export function compileExecAllowlistPattern(pattern: string): (target: string) => boolean {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return () => false;
  }
  let hasWildcard = WILDCARD.test(trimmed);
  // Home selection and literal Windows realpaths can change without a policy write.
  const dynamic = trimmed.startsWith("~") || (process.platform === "win32" && !hasWildcard);
  const resolvePattern = () => {
    const expanded = trimmed.startsWith("~") ? expandHomePrefix(trimmed) : trimmed;
    hasWildcard = WILDCARD.test(expanded);
    const resolved =
      process.platform === "win32" && !hasWildcard
        ? (safeRealpathSync(expanded) ?? expanded)
        : expanded;
    return compileGlobRegex(normalizeMatchTarget(resolved));
  };
  const compiled = dynamic ? undefined : resolvePattern();
  return (target) => {
    const regex = compiled ?? resolvePattern();
    let normalizedTarget =
      process.platform === "win32" && !hasWildcard ? (safeRealpathSync(target) ?? target) : target;
    normalizedTarget = normalizeMatchTarget(normalizedTarget);
    // Only targets normalize dot segments; doing so to a glob changes `*/..`.
    if (hasWildcard && DOT_PATH_SEGMENT.test(normalizedTarget)) {
      normalizedTarget = normalizeDotPathSegments(normalizedTarget);
    }
    return regex.test(normalizedTarget);
  };
}
