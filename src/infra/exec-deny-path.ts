import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
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
        // `**/` (globstar) matches zero or more leading path segments, so a
        // bare basename like `.env` is matched by `**/.env`, not just
        // `dir/.env` (#74379 review P1). A bare `**` (no trailing slash)
        // still matches anything including `/`.
        if (pattern[i + 2] === "/") {
          regex += "(?:.*/)?";
          i += 3;
          continue;
        }
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
// exec-allowlist-pattern.ts. The `\`->`/` rewrite is what lets a Windows-style
// path token (e.g. `C:\Users\op\.ssh\id_rsa`) match a POSIX-style deny pattern
// like `**/.ssh/*`; it runs on every host, not just win32, so an argv token
// carrying backslashes is still caught on a Linux/macOS gateway.
function normalizeMatchTarget(value: string): string {
  if (process.platform === "win32") {
    const stripped = value.replace(/^\\\\[?.]\\/, "");
    return normalizeLowercaseStringOrEmpty(stripped.replace(/\\/g, "/"));
  }
  return value.replace(/\\/g, "/");
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
    // POSIX shells use backslash as an escape; Windows shells use it as a path
    // separator. Only treat it as an escape on non-win32 hosts. On win32 the
    // backslash is preserved so a Windows-style path token inside a shell `-c`
    // payload (C:\\Users\\...\\.ssh) survives to normalizeMatchTarget, which
    // rewrites it to forward slashes for matching (#74379 P1). On a POSIX host
    // a `\` inside a shell payload is a genuine escape and is consumed here;
    // Windows paths arriving as discrete argv tokens (not shell-payload text)
    // skip this function entirely and still match via normalizeMatchTarget.
    if (process.platform !== "win32" && !inSingle && ch === "\\") {
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
  // `argv` crosses a process boundary (gateway/node-host wire payload), so a
  // non-array is a real hostile/malformed input, not a hypothetical: guard it
  // before iterating rather than trusting `?? []` to imply array-ness.
  const argv = Array.isArray(params.argv) ? params.argv : [];
  for (const arg of argv) {
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
    // Every non-flag candidate is matched against the patterns, even a bare
    // relative basename like `.env` with no cwd. Path-globs do not match
    // non-path tokens (`echo`, `done`) anyway, and skipping bare relatives
    // left the documented `**/.env` hard-deny unenforced on the no-cwd
    // node-host path (#74379 review P1).
    const expanded = expandHomePrefix(arg, { home: homeDir });
    // With a cwd, anchor relative targets to it. Without one, keep the value
    // relative rather than anchoring to the gateway's own process.cwd(): the
    // command's working directory is unknown here, so resolving against our
    // cwd would invent a path that could both miss real matches and create
    // false ones. The relative form is still matched because deny patterns use
    // the `**/` globstar (matches zero leading segments), so `config/.env` and
    // bare `.env` are caught by `**/.env`.
    let resolved: string;
    if (path.isAbsolute(expanded)) {
      resolved = path.resolve(expanded);
    } else if (cwd) {
      resolved = path.resolve(cwd, expanded);
    } else {
      resolved = expanded;
    }
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

const SHELL_WRAPPER_EXECUTABLE_RE = /^(?:bash|dash|fish|ksh|sh|zsh)$/i;
const SHELL_SHORT_OPTS_WITH_VALUE = new Set(["-O", "-o"]);

// Extract a shell `-c` payload from an argv array, e.g.
// ["/bin/sh", "-lc", "cat ~/.openclaw/secrets/x"] -> "cat ~/.openclaw/secrets/x".
// Used by call sites (node-host system.run) whose upstream parse leaves the
// payload in argv instead of a dedicated shellPayload field. POSIX-shell
// focused and mirrors extractShellWrappedCommandPayload in bash-tools.exec.ts.
// v1 deliberately does not parse cmd.exe / PowerShell wrappers (documented
// limitation in docs/tools/exec-approvals-advanced.md).
export function extractShellWrappedPayloadFromArgv(argv: readonly string[]): string | null {
  if (!Array.isArray(argv) || argv.length === 0) {
    return null;
  }
  let i = 0;
  while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i] ?? "")) {
    i += 1;
  }
  const executable = argv[i];
  if (typeof executable !== "string") {
    return null;
  }
  const base = (executable.split(/[\\/]/u).at(-1) ?? "").toLowerCase();
  const normalized = base.endsWith(".exe") ? base.slice(0, -4) : base;
  if (!SHELL_WRAPPER_EXECUTABLE_RE.test(normalized)) {
    return null;
  }
  const args = argv.slice(i + 1);
  for (let j = 0; j < args.length; j += 1) {
    const arg = args[j];
    if (arg === "--") {
      return null;
    }
    if (arg === "-c") {
      return args[j + 1] ?? null;
    }
    if (/^-[A-Za-z]+$/u.test(arg)) {
      if (arg.includes("c")) {
        return args[j + 1] ?? null;
      }
      if (SHELL_SHORT_OPTS_WITH_VALUE.has(arg)) {
        j += 1;
      }
      continue;
    }
    if (/^--[A-Za-z0-9][A-Za-z0-9-]*(?:=.*)?$/u.test(arg)) {
      if (!arg.includes("=")) {
        const next = args[j + 1];
        if (next && next !== "--" && !next.startsWith("-")) {
          j += 1;
        }
      }
      continue;
    }
    return null;
  }
  return null;
}
