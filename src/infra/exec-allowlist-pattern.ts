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

/**
 * Parse a subcommand pattern like "git *" or "git add:*" into a base pattern
 * and an argPattern regex.
 *
 * Format:
 *   "git *"        → basePattern="git",          argPattern="^[^\\s]+(\\s+.*)?$"  (any first arg)
 *   "git add:*"     → basePattern="git add",      argPattern="^git add\\\\s+.*$"    (add + args required)
 *   "git push:*"     → basePattern="git push",     argPattern="^git push\\\\s+.*$"   (push + args required)
 *   "git"          → basePattern="git",          argPattern=undefined                 (no restriction)
 *
 * Syntax:
 *   "*"  → any single token as subcommand (may appear with or without args)
 *   ":*" → specific subcommand, MUST be followed by at least one argument
 *
 * The subcommand is the last token before the ":*" or before the lone "*".
 */
export function parseSubcommandPattern(pattern: string): {
  basePattern: string;
  argPattern?: string;
} {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return { basePattern: trimmed };
  }

  const starIndex = trimmed.indexOf("*");
  if (starIndex === -1) {
    // No wildcard — no subcommand restriction
    return { basePattern: trimmed };
  }

  // Everything before the first "*" is the base
  const baseRaw = trimmed.slice(0, starIndex);
  const remainder = trimmed.slice(starIndex + 1);

  // If base ends with ":", the subcommand is specified and requires args
  const baseHasColon = baseRaw.endsWith(":");

  if (baseHasColon) {
    // "git add:*" — subcommand specified, args required
    const subcommand = baseRaw.slice(0, -1); // remove trailing ":"
    // Escape regex special chars in subcommand
    const escaped = subcommand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Match: subcommand followed by whitespace and >=1 arg token
    const argPattern = `^${escaped}\\s+.*$`;
    return { basePattern: subcommand, argPattern };
  } else {
    // "git *" — any first argument token (subcommand with optional args)
    const argPattern = `^[^/\\s]+(\\s+.*)?$`;
    return { basePattern: baseRaw.trimEnd(), argPattern };
  }
}

/**
 * Convert a subcommand glob pattern (e.g. "git *", "git add:*") to an
 * expanded ExecAllowlistEntry with base pattern + argPattern.
 */
export function expandSubcommandEntry(
  pattern: string,
): { pattern: string; argPattern?: string } {
  const { basePattern, argPattern } = parseSubcommandPattern(pattern);
  return { pattern: basePattern, argPattern };
}
