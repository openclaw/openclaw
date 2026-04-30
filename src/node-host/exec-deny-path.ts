import os from "node:os";
import path from "node:path";

// Compile a glob pattern to a regex.
// `**` matches any characters including `/`.
// `*` matches any characters except `/`.
// `?` matches a single non-`/` character.
// All other characters are matched literally.
//
// Mirrors the style used in src/infra/exec-allowlist-pattern.ts so the deny
// surface and the allowlist surface stay readable together. Kept local here
// because the deny gate runs before allowlist evaluation and must not depend
// on allowlist-runtime ordering.
const globRegexCache = new Map<string, RegExp>();
const GLOB_REGEX_CACHE_LIMIT = 256;

function escapeRegExpLiteral(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileDenyPathGlob(pattern: string): RegExp {
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
  const compiled = new RegExp(regex);
  if (globRegexCache.size >= GLOB_REGEX_CACHE_LIMIT) {
    globRegexCache.clear();
  }
  globRegexCache.set(pattern, compiled);
  return compiled;
}

function expandTilde(value: string, homedir: () => string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(homedir(), value.slice(2));
  }
  return value;
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
  return arg === "~" || arg.startsWith("~/") || arg.startsWith("/") || arg.includes("/");
}

// Best-effort tokenization of a shell payload string. Respects single and
// double quotes. Does not attempt to handle heredocs, command substitution,
// `eval`, base64 decoding, or other indirection — v1 is explicitly the
// "lazy `cat ~/.openclaw/secrets/...` case", not a complete sandbox.
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
  homedir: () => string,
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
    const expanded = expandTilde(trimmed, homedir);
    out.push({
      raw: trimmed,
      expanded,
      regexExpanded: compileDenyPathGlob(expanded),
      regexRaw: compileDenyPathGlob(trimmed),
    });
  }
  return out;
}

export function evaluateExecDenyPathMatch(params: {
  patterns: readonly string[];
  argv: readonly string[];
  shellPayload?: string | null;
  cwd?: string | null;
  homedir?: () => string;
}): DenyPathMatch | null {
  const homedir = params.homedir ?? os.homedir;
  const compiled = compilePatterns(params.patterns ?? [], homedir);
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
    if (!isPathLikeArg(arg)) {
      continue;
    }
    const expanded = expandTilde(arg, homedir);
    const resolved =
      cwd && !path.isAbsolute(expanded) ? path.resolve(cwd, expanded) : path.resolve(expanded);
    for (const pattern of compiled) {
      if (
        pattern.regexRaw.test(arg) ||
        pattern.regexExpanded.test(expanded) ||
        pattern.regexExpanded.test(resolved)
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
