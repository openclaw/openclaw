/**
 * Exec denylist (STOP-list) screening.
 *
 * Denylist entries are glob patterns (`*` and `?`) matched against analyzed
 * command segments. Any match forces an explicit approval even when
 * `security=full` and `ask=off` would otherwise auto-allow the command, and
 * durable allow-always trust never clears a hit. This is a guardrail against
 * unintended high-risk commands, not a sandbox: adversarial payloads should
 * still be confined with `security=allowlist` or `security=deny`.
 */
import path from "node:path";
import type { ExecCommandSegment } from "./exec-approvals-analysis.js";
import type { ExecDenylistEntry } from "./exec-approvals.types.js";
import { planShellAuthorization } from "./exec-authorization-plan.js";
import { normalizeExecutableToken } from "./exec-wrapper-resolution.js";
import { POSIX_INLINE_COMMAND_FLAGS, resolveInlineCommandMatch } from "./shell-inline-command.js";
import {
  POSIX_SHELL_WRAPPERS,
  resolveShellWrapperTransportArgv,
} from "./shell-wrapper-resolution.js";

const MAX_DENYLIST_INLINE_DEPTH = 3;

const POSIX_SHELL_WRAPPER_NAMES: ReadonlySet<string> = POSIX_SHELL_WRAPPERS;

// Wrapper executables whose inline payloads use parsing semantics this module
// cannot analyze; segments carrying their inline flags are treated as hits.
const OPAQUE_INLINE_WRAPPER_TOKENS = new Set(["cmd", "cmd.exe", "powershell", "pwsh"]);
const OPAQUE_INLINE_FLAG_TOKENS = new Set(["/c", "/k", "-command", "-c", "-encodedcommand"]);

export type ExecDenylistEvaluation = {
  matched: boolean;
  entry: ExecDenylistEntry | null;
  matchedText: string | null;
  unanalyzable: boolean;
};

type DenylistMatcher = {
  entry: ExecDenylistEntry;
  regex: RegExp;
};

const NOT_MATCHED: ExecDenylistEvaluation = {
  matched: false,
  entry: null,
  matchedText: null,
  unanalyzable: false,
};

const UNANALYZABLE_HIT: ExecDenylistEvaluation = {
  matched: true,
  entry: null,
  matchedText: null,
  unanalyzable: true,
};

/** Drops malformed entries; preserves array identity when nothing changes. */
export function sanitizeExecDenylistEntries(entries: unknown): ExecDenylistEntry[] {
  if (!Array.isArray(entries)) {
    return [];
  }
  let changed = false;
  const sanitized: ExecDenylistEntry[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      changed = true;
      continue;
    }
    const candidate = raw as { id?: unknown; pattern?: unknown; reason?: unknown };
    const pattern = typeof candidate.pattern === "string" ? candidate.pattern.trim() : "";
    if (!pattern) {
      changed = true;
      continue;
    }
    const id =
      typeof candidate.id === "string" && candidate.id.trim().length > 0
        ? candidate.id.trim()
        : undefined;
    const reason =
      typeof candidate.reason === "string" && candidate.reason.trim().length > 0
        ? candidate.reason.trim()
        : undefined;
    if (pattern !== candidate.pattern || id !== candidate.id || reason !== candidate.reason) {
      changed = true;
    }
    sanitized.push({
      ...(id !== undefined ? { id } : {}),
      pattern,
      ...(reason !== undefined ? { reason } : {}),
    });
  }
  return changed ? sanitized : (entries as ExecDenylistEntry[]);
}

function denylistPatternToRegExp(pattern: string, caseInsensitive: boolean): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[\\s\\S]*")
    .replace(/\?/g, "[\\s\\S]");
  return new RegExp(`^${escaped}$`, caseInsensitive ? "i" : undefined);
}

function buildDenylistMatchers(
  entries: readonly ExecDenylistEntry[],
  caseInsensitive: boolean,
): DenylistMatcher[] {
  return entries.map((entry) => ({
    entry,
    regex: denylistPatternToRegExp(entry.pattern, caseInsensitive),
  }));
}

function addArgvCandidates(out: Set<string>, argv: readonly string[] | undefined): void {
  if (!argv || argv.length === 0) {
    return;
  }
  const joined = argv.join(" ").trim();
  if (joined.length > 0) {
    out.add(joined);
  }
  const head = argv[0] ?? "";
  const base = path.basename(head);
  if (base.length > 0 && base !== head) {
    out.add([base, ...argv.slice(1)].join(" ").trim());
  }
}

function buildSegmentCandidateTexts(segment: ExecCommandSegment): string[] {
  const candidates = new Set<string>();
  addArgvCandidates(candidates, segment.argv);
  const effectiveArgv = segment.resolution?.effectiveArgv;
  if (effectiveArgv && effectiveArgv.length > 0) {
    addArgvCandidates(candidates, effectiveArgv);
  }
  return [...candidates];
}

function hasOpaqueInlinePayload(argv: readonly string[]): boolean {
  const wrapperToken = normalizeExecutableToken(argv[0] ?? "");
  if (!OPAQUE_INLINE_WRAPPER_TOKENS.has(wrapperToken)) {
    return false;
  }
  return argv.some((token) => OPAQUE_INLINE_FLAG_TOKENS.has(token.trim().toLowerCase()));
}

function resolvePosixInlineCommand(argv: string[]): string | null {
  const transportArgv = resolveShellWrapperTransportArgv(argv) ?? argv;
  if (!POSIX_SHELL_WRAPPER_NAMES.has(normalizeExecutableToken(transportArgv[0] ?? ""))) {
    return null;
  }
  const match = resolveInlineCommandMatch(transportArgv, POSIX_INLINE_COMMAND_FLAGS, {
    allowCombinedC: true,
  });
  const inline = match.command?.trim();
  return inline && inline.length > 0 ? inline : null;
}

async function evaluateSegmentsAgainstDenylist(params: {
  segments: readonly ExecCommandSegment[];
  matchers: readonly DenylistMatcher[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
  depth: number;
}): Promise<ExecDenylistEvaluation> {
  for (const segment of params.segments) {
    for (const candidate of buildSegmentCandidateTexts(segment)) {
      for (const matcher of params.matchers) {
        if (matcher.regex.test(candidate)) {
          return {
            matched: true,
            entry: matcher.entry,
            matchedText: candidate,
            unanalyzable: false,
          };
        }
      }
    }
    if (hasOpaqueInlinePayload(segment.argv)) {
      return UNANALYZABLE_HIT;
    }
    const inlineCommand = resolvePosixInlineCommand(segment.argv);
    if (inlineCommand === null) {
      continue;
    }
    if (params.depth + 1 >= MAX_DENYLIST_INLINE_DEPTH) {
      return UNANALYZABLE_HIT;
    }
    // Upstream replaced sync analyzeShellCommand with async shell planning.
    const inlinePlan = await planShellAuthorization({
      command: inlineCommand,
      cwd: params.cwd,
      env: params.env,
      platform: params.platform,
    });
    const inlineSegments = inlinePlan.ok
      ? inlinePlan.groups.flatMap((group) =>
          group.candidates.map((candidate) => candidate.sourceSegment),
        )
      : [];
    if (!inlinePlan.ok || inlineSegments.length === 0) {
      return UNANALYZABLE_HIT;
    }
    const inlineEvaluation = await evaluateSegmentsAgainstDenylist({
      segments: inlineSegments,
      matchers: params.matchers,
      cwd: params.cwd,
      env: params.env,
      platform: params.platform,
      depth: params.depth + 1,
    });
    if (inlineEvaluation.matched) {
      return inlineEvaluation;
    }
  }
  return NOT_MATCHED;
}

/**
 * Screens analyzed command segments against the configured denylist.
 *
 * Reuses the segments produced by allowlist analysis so screening adds no
 * extra parsing cost. When the command could not be analyzed and a denylist
 * is configured, the evaluation conservatively reports a hit because the
 * command cannot be proven to miss the STOP list.
 */
export async function evaluateExecDenylist(params: {
  denylist: readonly ExecDenylistEntry[] | undefined | null;
  segments: readonly ExecCommandSegment[];
  analysisOk: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
}): Promise<ExecDenylistEvaluation> {
  const entries = sanitizeExecDenylistEntries(params.denylist);
  if (entries.length === 0) {
    return NOT_MATCHED;
  }
  if (!params.analysisOk || params.segments.length === 0) {
    return UNANALYZABLE_HIT;
  }
  const caseInsensitive = (params.platform ?? process.platform) === "win32";
  return await evaluateSegmentsAgainstDenylist({
    segments: params.segments,
    matchers: buildDenylistMatchers(entries, caseInsensitive),
    cwd: params.cwd,
    env: params.env,
    platform: params.platform,
    depth: 0,
  });
}

/** Operator-facing denial message for denylist screening outcomes. */
export function formatExecDenylistDeniedMessage(evaluation: ExecDenylistEvaluation): string {
  if (evaluation.unanalyzable) {
    return "SYSTEM_RUN_DENIED: denylist screening could not analyze command; approval required";
  }
  const reason = evaluation.entry?.reason ? ` (${evaluation.entry.reason})` : "";
  return `SYSTEM_RUN_DENIED: denylist match (${evaluation.entry?.pattern ?? "unknown"})${reason}; approval required`;
}

/** Warning line surfaced with approval prompts for denylist screening hits. */
export function formatExecDenylistWarning(evaluation: ExecDenylistEvaluation): string {
  if (evaluation.unanalyzable) {
    return "Warning: command could not be analyzed for denylist screening; explicit approval is required.";
  }
  const reason = evaluation.entry?.reason ? ` (${evaluation.entry.reason})` : "";
  return `Warning: command matches exec denylist entry ${evaluation.entry?.pattern ?? "unknown"}${reason}; explicit approval is required (Ask=off does not bypass the STOP list).`;
}

/**
 * In yolo mode (`security=full` + `ask=off`), unanalyzable denylist hits must not
 * open a human approval prompt. Conservatively refusing the opaque command (so
 * the agent retries an analyzable form) is fail-closed for the STOP list without
 * turning every pipe/redirect/`$()` improvisation into a one-shot Allow-once
 * card for the operator. Pattern-matched denylist hits still require approval.
 */
export function shouldHardDenyUnanalyzableDenylistHit(params: {
  security: string;
  ask: string;
  evaluation: ExecDenylistEvaluation;
}): boolean {
  return (
    params.evaluation.matched &&
    params.evaluation.unanalyzable &&
    params.security === "full" &&
    params.ask === "off"
  );
}

/** Operator/agent-facing denial when yolo mode hard-denies an opaque command. */
export function formatUnanalyzableDenylistHardDenyMessage(command?: string): string {
  const commandLine = command?.trim() ? `\nRefused command: ${command.trim()}` : "";
  return [
    "SYSTEM_RUN_DENIED: command could not be analyzed for denylist screening.",
    "Ask=off / security=full does not auto-allow opaque shell (pipes, redirects,",
    "command substitution, `||`/`&&` chains the planner cannot prove miss the STOP list).",
    "Retry with an analyzable form:",
    "- prefer native `read` / `write` / `list` / `glob` / `sessions_*` tools for files and sessions",
    "- use bare `gws … --help` (no `| head`, no `2>&1`)",
    "- for email / Drive / Docs with large bodies or JSON, use `tools/bin/lisa-safe` subcommands",
    "- never embed large multiline bodies or `$(cat …)` in the exec command line",
    commandLine,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}
