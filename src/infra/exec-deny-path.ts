import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { expandHomePrefix, resolveEffectiveHomeDir } from "./home-dir.js";

// Compile a glob pattern to a regex.
// `**` matches any characters including `/`.
// `*` matches any characters except `/`.
// `?` matches a single non-`/` character.
// All other characters are matched literally.
//
// Mirrors the style used in src/infra/exec-allowlist-pattern.ts so the deny
// surface and the allowlist surface stay readable together. Cache key is
// platform-scoped because Windows compiles with the case-insensitive flag.
const globRegexCache = new Map<string, RegExp>();
const GLOB_REGEX_CACHE_LIMIT = 256;

function escapeRegExpLiteral(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileDenyPathGlob(pattern: string): RegExp {
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

// Normalizes paths/patterns for cross-platform glob matching: strips Win32
// `\\?\`/`\\.\` prefixes, replaces `\` with `/`, and lowercases on Windows
// for case-insensitive matching. Mirrors normalizeMatchTarget in
// exec-allowlist-pattern.ts.
function normalizeMatchTarget(value: string): string {
  if (process.platform === "win32") {
    const stripped = value.replace(/^\\\\[?.]\\/, "");
    return normalizeLowercaseStringOrEmpty(stripped.replace(/\\/g, "/"));
  }
  return value.replace(/\\/g, "/");
}

function isPathLikeArg(arg: string): boolean {
  if (typeof arg !== "string" || arg.length === 0) {
    return false;
  }
  // Skip flags. `--token=secret` is not a path; the env-style assignment is
  // also not a path. Bare `-` and `--` separators are not paths.
  if (arg.startsWith("-")) {
    return false;
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
    return false;
  }
  if (arg === "~" || arg.startsWith("~/") || arg.startsWith("~\\")) {
    return true;
  }
  if (arg.startsWith("/") || arg.includes("/")) {
    return true;
  }
  // Windows absolute or backslash-separated paths.
  if (process.platform === "win32") {
    if (/^[A-Za-z]:[\\/]/.test(arg) || arg.includes("\\")) {
      return true;
    }
  }
  return false;
}

function isSkippedCandidateArg(arg: string): boolean {
  if (typeof arg !== "string" || arg.length === 0) {
    return true;
  }
  // Skip flags. `--token=secret` is not a path; the env-style assignment is
  // also not a path. Bare `-` and `--` separators are not paths.
  if (arg.startsWith("-")) {
    return true;
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
    return true;
  }
  return false;
}

// Best-effort tokenization of a shell payload string. Respects single and
// double quotes and a single layer of `\` escapes outside single quotes.
// Does not attempt to handle heredocs, command substitution, `eval`, base64
// decoding, or other indirection — v1 is explicitly the "lazy `cat
// ~/.openclaw/secrets/...` case", not a complete sandbox.
export function tokenizeShellPayload(payload: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  let escape = false;
  for (const ch of payload) {
    if (escape) {
      buf += ch;
      escape = false;
      continue;
    }
    if (!inSingle && ch === "\\") {
      escape = true;
      continue;
    }
    if (!inDouble && ch === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && /\s/.test(ch)) {
      if (buf) {
        out.push(buf);
        buf = "";
      }
      continue;
    }
    if (!inSingle && !inDouble && /[;&|<>()]/.test(ch)) {
      if (buf) {
        out.push(buf);
        buf = "";
      }
      continue;
    }
    buf += ch;
  }
  if (buf) {
    out.push(buf);
  }
  return out;
}

export type DenyPathMatch = {
  pattern: string;
  arg: string;
  resolved: string;
};

type CompiledDenyPattern = {
  raw: string;
  expanded: string;
  regexExpanded: RegExp;
  regexRaw: RegExp;
};

function compilePatterns(
  patterns: readonly string[],
  homeDir: string | undefined,
): CompiledDenyPattern[] {
  const out: CompiledDenyPattern[] = [];
  for (const candidate of patterns) {
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim();
    if (!trimmed) {
      continue;
    }
    const expanded = expandHomePrefix(trimmed, { home: homeDir });
    out.push({
      raw: trimmed,
      expanded,
      regexExpanded: compileDenyPathGlob(normalizeMatchTarget(expanded)),
      regexRaw: compileDenyPathGlob(normalizeMatchTarget(trimmed)),
    });
  }
  return out;
}

export function evaluateExecDenyPathMatch(params: {
  patterns: readonly string[];
  argv: readonly string[];
  shellPayload?: string | null;
  cwd?: string | null;
  // Optional overrides for tests. Production resolves through the standard
  // OPENCLAW_HOME / HOME / USERPROFILE / os.homedir cascade in
  // resolveEffectiveHomeDir.
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}): DenyPathMatch | null {
  const homeDir = params.homeDir ?? resolveEffectiveHomeDir(params.env ?? process.env);
  const compiled = compilePatterns(params.patterns ?? [], homeDir);
  if (compiled.length === 0) {
    return null;
  }

  const candidates: string[] = [];
  for (const arg of params.argv ?? []) {
    if (typeof arg === "string") {
      candidates.push(arg);
    }
  }
  if (typeof params.shellPayload === "string" && params.shellPayload.length > 0) {
    for (const token of tokenizeShellPayload(params.shellPayload)) {
      candidates.push(token);
    }
  }

  const cwd = typeof params.cwd === "string" && params.cwd.length > 0 ? params.cwd : null;

  for (const arg of candidates) {
    if (isSkippedCandidateArg(arg)) {
      continue;
    }
    if (!cwd && !isPathLikeArg(arg)) {
      continue;
    }
    const expanded = expandHomePrefix(arg, { home: homeDir });
    const resolved =
      cwd && !path.isAbsolute(expanded)
        ? path.resolve(cwd, expanded)
        : path.isAbsolute(expanded)
          ? path.resolve(expanded)
          : expanded;
    const normalizedArg = normalizeMatchTarget(arg);
    const normalizedExpanded = normalizeMatchTarget(expanded);
    const normalizedResolved = normalizeMatchTarget(resolved);
    for (const pattern of compiled) {
      if (
        pattern.regexRaw.test(normalizedArg) ||
        pattern.regexExpanded.test(normalizedExpanded) ||
        pattern.regexExpanded.test(normalizedResolved)
      ) {
        return { pattern: pattern.raw, arg, resolved };
      }
    }
  }
  return null;
}

export function formatExecDenyPathMessage(match: DenyPathMatch): string {
  return `SYSTEM_RUN_DENIED: argument matches tools.exec.denyPathPatterns (pattern=${JSON.stringify(match.pattern)}, arg=${JSON.stringify(match.arg)})`;
}

// Merges global and per-agent denyPathPatterns as a union. Agents can extend
// the deny list but cannot relax it by overriding to a shorter list.
export function resolveExecDenyPathPatterns(params: {
  global?: readonly string[] | undefined;
  agent?: readonly string[] | undefined;
}): string[] {
  const out = new Set<string>();
  for (const list of [params.global, params.agent]) {
    if (!Array.isArray(list)) {
      continue;
    }
    for (const entry of list) {
      if (typeof entry !== "string") {
        continue;
      }
      const trimmed = entry.trim();
      if (trimmed) {
        out.add(trimmed);
      }
    }
  }
  return Array.from(out);
}
