import fs from "node:fs";
import { expandHomePrefix } from "./home-dir.js";

const GLOB_REGEX_CACHE_LIMIT = 512;
const globRegexCache = new Map<string, RegExp>();

type MatchTargetOptions = {
  caseSensitive?: boolean;
};

function normalizeMatchTarget(value: string, options: MatchTargetOptions = {}): string {
  const caseSensitive = options.caseSensitive === true;
  if (process.platform === "win32") {
    const stripped = value.replace(/^\\\\[?.]\\/, "");
    const normalized = stripped.replace(/\\/g, "/");
    return caseSensitive ? normalized : normalized.toLowerCase();
  }
  const normalized = value.replace(/\\\\/g, "/");
  return caseSensitive ? normalized : normalized.toLowerCase();
}

function tryRealpath(value: string): string | null {
  try {
    return fs.realpathSync(value);
  } catch {
    return null;
  }
}

function escapeRegExpLiteral(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type CompileGlobRegexOptions = {
  caseSensitive?: boolean;
};

function compileGlobRegex(pattern: string, options: CompileGlobRegexOptions = {}): RegExp {
  const caseSensitive = options.caseSensitive === true;
  const cacheKey = `${caseSensitive ? "cs" : "ci"}:${pattern}`;
  const cached = globRegexCache.get(cacheKey);
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
      regex += ".";
      i += 1;
      continue;
    }
    regex += escapeRegExpLiteral(ch);
    i += 1;
  }
  regex += "$";

  const compiled = new RegExp(regex, caseSensitive ? "" : "i");
  if (globRegexCache.size >= GLOB_REGEX_CACHE_LIMIT) {
    globRegexCache.clear();
  }
  globRegexCache.set(cacheKey, compiled);
  return compiled;
}

type MatchExecAllowlistPatternOptions = {
  caseSensitive?: boolean;
};

export function matchesExecAllowlistPattern(
  pattern: string,
  target: string,
  options: MatchExecAllowlistPatternOptions = {},
): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return false;
  }
  const caseSensitive = options.caseSensitive === true;

  const expanded = trimmed.startsWith("~") ? expandHomePrefix(trimmed) : trimmed;
  const hasWildcard = /[*?]/.test(expanded);
  let normalizedPattern = expanded;
  let normalizedTarget = target;
  if (process.platform === "win32" && !hasWildcard) {
    normalizedPattern = tryRealpath(expanded) ?? expanded;
    normalizedTarget = tryRealpath(target) ?? target;
  }
  normalizedPattern = normalizeMatchTarget(normalizedPattern, { caseSensitive });
  normalizedTarget = normalizeMatchTarget(normalizedTarget, { caseSensitive });
  return compileGlobRegex(normalizedPattern, { caseSensitive }).test(normalizedTarget);
}
