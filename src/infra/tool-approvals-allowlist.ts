/**
 * Tool-name-based allowlist matching for MCP/plugin tool approvals.
 *
 * Patterns are glob-style matches against normalized tool names.
 * Examples:
 *   - "github__list_*"       matches any tool starting with "github__list_"
 *   - "github__*"            matches any tool from the "github" MCP server
 *   - "exec__*"              matches any exec-prefixed tool
 *   - "*__read_*"            matches any read tool across servers
 *   - "*"                    matches any tool name
 *
 * Glob semantics:
 *   - `*`  matches any characters
 *   - `?`  matches a single character
 *
 * Matching is case-insensitive.
 */

import type { ToolAllowlistEntry } from "./tool-approvals.js";

const GLOB_REGEX_CACHE_LIMIT = 512;
const globRegexCache = new Map<string, RegExp>();

function escapeRegExpLiteral(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileToolGlobRegex(pattern: string): RegExp {
  const cached = globRegexCache.get(pattern);
  if (cached) {
    return cached;
  }

  let regex = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      // Tool names are flat strings (no path separators), so * matches everything.
      regex += ".*";
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

  const compiled = new RegExp(regex, "i");
  if (globRegexCache.size >= GLOB_REGEX_CACHE_LIMIT) {
    globRegexCache.clear();
  }
  globRegexCache.set(pattern, compiled);
  return compiled;
}

function normalizeToolNameForMatch(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.toLowerCase();
}

function matchesToolPattern(normalizedName: string, pattern: string): boolean {
  const lowerPattern = pattern.toLowerCase().trim();
  if (!lowerPattern) {
    return false;
  }
  return compileToolGlobRegex(lowerPattern).test(normalizedName);
}

/**
 * Match a tool name against the allowlist. Returns the first matching entry or null.
 */
export function matchToolAllowlist(
  allowlist: readonly ToolAllowlistEntry[],
  toolName: string,
): ToolAllowlistEntry | null {
  if (!allowlist || allowlist.length === 0) {
    return null;
  }
  const normalized = normalizeToolNameForMatch(toolName);
  if (!normalized) {
    return null;
  }
  for (const entry of allowlist) {
    const pattern = entry.pattern?.trim();
    if (!pattern) {
      continue;
    }
    // Bare wildcard matches any tool
    if (pattern === "*" || pattern === "**") {
      return entry;
    }
    if (matchesToolPattern(normalized, pattern)) {
      return entry;
    }
  }
  return null;
}

export type ToolAllowlistEvaluation = {
  allowlistSatisfied: boolean;
  matchedEntry: ToolAllowlistEntry | null;
};

export function evaluateToolAllowlist(params: {
  toolName: string;
  allowlist: readonly ToolAllowlistEntry[];
}): ToolAllowlistEvaluation {
  const match = matchToolAllowlist(params.allowlist, params.toolName);
  return {
    allowlistSatisfied: match !== null,
    matchedEntry: match,
  };
}
