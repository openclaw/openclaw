import {
  resolveExecutionTargetResolution,
  type ExecCommandAnalysis,
  type ExecCommandSegment,
} from "./exec-approvals-analysis.js";

export const BUILTIN_EXEC_DENY_PATTERNS = [
  "rm -rf /",
  "rm -rf /*",
  "mkfs.*",
  "dd * of=/dev/*",
] as const;

const GLOB_REGEX_CACHE_LIMIT = 512;
const globRegexCache = new Map<string, RegExp>();

function escapeRegExpLiteral(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileGlobRegex(pattern: string): RegExp {
  const cacheKey = pattern;
  const cached = globRegexCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  let regex = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
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

  const compiled = new RegExp(regex);
  if (globRegexCache.size >= GLOB_REGEX_CACHE_LIMIT) {
    globRegexCache.clear();
  }
  globRegexCache.set(cacheKey, compiled);
  return compiled;
}

function normalizeCommandText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function normalizeExecDenylist(entries?: readonly string[] | null): string[] {
  if (!Array.isArray(entries)) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const normalized = normalizeCommandText(entry);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function resolveExecDenylist(entries?: readonly string[] | null): string[] {
  const configured = normalizeExecDenylist(entries);
  const builtins: string[] = Array.from(BUILTIN_EXEC_DENY_PATTERNS);
  if (configured.length === 0) {
    return builtins;
  }
  const seen = new Set<string>(builtins);
  for (const entry of configured) {
    if (!seen.has(entry)) {
      builtins.push(entry);
      seen.add(entry);
    }
  }
  return builtins;
}

const SHELL_WRAPPERS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);

function extractInlineShellPayload(segment: ExecCommandSegment): string | null {
  const argv = segment.argv;
  if (argv.length < 3) {
    return null;
  }
  const exe = (argv[0] ?? "").replace(/^.*\//, "").toLowerCase();
  if (!SHELL_WRAPPERS.has(exe)) {
    return null;
  }
  const flagIdx = argv.indexOf("-c");
  if (flagIdx === -1 || flagIdx + 1 >= argv.length) {
    const lcIdx = argv.indexOf("-lc");
    if (lcIdx !== -1 && lcIdx + 1 < argv.length) {
      return argv[lcIdx + 1] ?? null;
    }
    return null;
  }
  return argv[flagIdx + 1] ?? null;
}

function resolveSegmentCandidates(segment: ExecCommandSegment): string[] {
  const candidates = new Set<string>();
  const raw = normalizeCommandText(segment.raw);
  if (raw) {
    candidates.add(raw);
  }
  const argv = segment.argv.map((value) => value.trim()).filter(Boolean);
  if (argv.length > 0) {
    candidates.add(normalizeCommandText(argv.join(" ")));
  }
  const execution = resolveExecutionTargetResolution(segment.resolution);
  for (const value of [execution?.executableName, execution?.rawExecutable, segment.argv[0]]) {
    const normalized = normalizeCommandText(value ?? "");
    if (normalized) {
      candidates.add(normalized);
    }
  }
  // Add basename-only candidate for absolute executable paths (e.g. /bin/rm -> rm)
  if (execution?.rawExecutable && execution.rawExecutable.includes("/")) {
    const basename = execution.rawExecutable.replace(/^.*\//, "");
    if (basename && argv.length > 1) {
      const basenameCmd = normalizeCommandText([basename, ...argv.slice(1)].join(" "));
      candidates.add(basenameCmd);
    }
  }
  // Extract inline shell payloads (e.g. bash -c 'rm -rf /')
  const payload = extractInlineShellPayload(segment);
  if (payload) {
    candidates.add(normalizeCommandText(payload));
  }
  return [...candidates];
}

export function matchesDenyPattern(segmentCandidates: readonly string[], pattern: string): boolean {
  if (segmentCandidates.length === 0) {
    return false;
  }
  const matcher = compileGlobRegex(pattern);
  return segmentCandidates.some((candidate) => matcher.test(candidate));
}

export function matchesExecDenylist(params: {
  analysis: ExecCommandAnalysis;
  commandText?: string;
  denylist?: readonly string[] | null;
}): {
  denied: boolean;
  pattern: string | null;
} {
  const denyPatterns = resolveExecDenylist(params.denylist);
  const fullCommand = normalizeCommandText(params.commandText ?? "");

  // Always check the raw command text, even when analysis failed.
  // An attacker could craft input that causes parser failure while still
  // matching a deny pattern (e.g. backslash-newline continuations).
  if (fullCommand) {
    for (const pattern of denyPatterns) {
      const matcher = compileGlobRegex(pattern);
      if (matcher.test(fullCommand)) {
        return { denied: true, pattern };
      }
    }
  }

  if (!params.analysis.ok || params.analysis.segments.length === 0) {
    return { denied: false, pattern: null };
  }

  const allSegmentCandidates = params.analysis.segments.flatMap(resolveSegmentCandidates);

  for (const pattern of denyPatterns) {
    if (matchesDenyPattern(allSegmentCandidates, pattern)) {
      return { denied: true, pattern };
    }
  }
  return { denied: false, pattern: null };
}
