import fs from "node:fs";
import { expandHomePrefix } from "./home-dir.js";

const GLOB_REGEX_CACHE_LIMIT = 512;
const globRegexCache = new Map<string, RegExp>();

function normalizeMatchTarget(value: string): string {
  if (process.platform === "win32") {
    const stripped = value.replace(/^\\\\[?.]\\/, "");
    return stripped.replace(/\\/g, "/").toLowerCase();
  }
  return value.replace(/\\\\/g, "/");
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

function compileGlobRegex(pattern: string): RegExp {
  const cacheKey = `${process.platform}:${pattern}`;
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
      regex += "[^/]";
      i += 1;
      continue;
    }
    regex += escapeRegExpLiteral(ch);
    i += 1;
  }
  regex += "$";

  const compiled = new RegExp(regex, process.platform === "win32" ? "i" : "");
  if (globRegexCache.size >= GLOB_REGEX_CACHE_LIMIT) {
    globRegexCache.clear();
  }
  globRegexCache.set(cacheKey, compiled);
  return compiled;
}

export function matchesExecAllowlistPattern(pattern: string, target: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return false;
  }

  const expanded = trimmed.startsWith("~") ? expandHomePrefix(trimmed) : trimmed;
  const hasWildcard = /[*?]/.test(expanded);
  let normalizedPattern = expanded;
  let normalizedTarget = target;
  if (process.platform === "win32" && !hasWildcard) {
    normalizedPattern = tryRealpath(expanded) ?? expanded;
    normalizedTarget = tryRealpath(target) ?? target;
  }
  normalizedPattern = normalizeMatchTarget(normalizedPattern);
  normalizedTarget = normalizeMatchTarget(normalizedTarget);
  return compileGlobRegex(normalizedPattern).test(normalizedTarget);
}
