import {
  DEFAULT_SAFE_BINS,
  analyzeShellCommand,
  isWindowsPlatform,
  matchAllowlist,
  resolveAllowlistCandidatePath,
  resolveCommandResolutionFromArgv,
  splitCommandChain,
  type ExecCommandAnalysis,
  type CommandResolution,
  type ExecCommandSegment,
} from "./exec-approvals-analysis.js";
import type { ExecAllowlistEntry } from "./exec-approvals.js";
import {
  SAFE_BIN_PROFILES,
  type SafeBinProfile,
  validateSafeBinArgv,
} from "./exec-safe-bin-policy.js";
import { isTrustedSafeBinPath } from "./exec-safe-bin-trust.js";
import {
  extractShellWrapperInlineCommand,
  isDispatchWrapperExecutable,
  isShellWrapperExecutable,
  unwrapKnownDispatchWrapperInvocation,
} from "./exec-wrapper-resolution.js";

function hasShellLineContinuation(command: string): boolean {
  return /\\(?:\r\n|\n|\r)/.test(command);
}

export function normalizeSafeBins(entries?: string[]): Set<string> {
  if (!Array.isArray(entries)) {
    return new Set();
  }
  const normalized = entries
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return new Set(normalized);
}

export function resolveSafeBins(entries?: string[] | null): Set<string> {
  if (entries === undefined) {
    return normalizeSafeBins(DEFAULT_SAFE_BINS);
  }
  return normalizeSafeBins(entries ?? []);
}

export function isSafeBinUsage(params: {
  argv: string[];
  resolution: CommandResolution | null;
  safeBins: Set<string>;
  platform?: string | null;
  trustedSafeBinDirs?: ReadonlySet<string>;
  safeBinProfiles?: Readonly<Record<string, SafeBinProfile>>;
  isTrustedSafeBinPathFn?: typeof isTrustedSafeBinPath;
}): boolean {
  // Windows host exec uses PowerShell, which has different parsing/expansion rules.
  // Keep safeBins conservative there (require explicit allowlist entries).
  if (isWindowsPlatform(params.platform ?? process.platform)) {
    return false;
  }
  if (params.safeBins.size === 0) {
    return false;
  }
  const resolution = params.resolution;
  const execName = resolution?.executableName?.toLowerCase();
  if (!execName) {
    return false;
  }
  const matchesSafeBin = params.safeBins.has(execName);
  if (!matchesSafeBin) {
    return false;
  }
  if (!resolution?.resolvedPath) {
    return false;
  }
  const isTrustedPath = params.isTrustedSafeBinPathFn ?? isTrustedSafeBinPath;
  if (
    !isTrustedPath({
      resolvedPath: resolution.resolvedPath,
      trustedDirs: params.trustedSafeBinDirs,
    })
  ) {
    return false;
  }
  const argv = params.argv.slice(1);
  const safeBinProfiles = params.safeBinProfiles ?? SAFE_BIN_PROFILES;
  const profile = safeBinProfiles[execName];
  if (!profile) {
    return false;
  }
  return validateSafeBinArgv(argv, profile);
}

function isPathScopedExecutableToken(token: string): boolean {
  return token.includes("/") || token.includes("\\");
}

export type ExecAllowlistEvaluation = {
  allowlistSatisfied: boolean;
  allowlistMatches: ExecAllowlistEntry[];
  segmentSatisfiedBy: ExecSegmentSatisfiedBy[];
};

export type ExecSegmentSatisfiedBy = "allowlist" | "safeBins" | "skills" | null;

function evaluateSegments(
  segments: ExecCommandSegment[],
  params: {
    allowlist: ExecAllowlistEntry[];
    safeBins: Set<string>;
    safeBinProfiles?: Readonly<Record<string, SafeBinProfile>>;
    cwd?: string;
    platform?: string | null;
    trustedSafeBinDirs?: ReadonlySet<string>;
    skillBins?: Set<string>;
    autoAllowSkills?: boolean;
  },
): {
  satisfied: boolean;
  matches: ExecAllowlistEntry[];
  segmentSatisfiedBy: ExecSegmentSatisfiedBy[];
} {
  const matches: ExecAllowlistEntry[] = [];
  const allowSkills = params.autoAllowSkills === true && (params.skillBins?.size ?? 0) > 0;
  const segmentSatisfiedBy: ExecSegmentSatisfiedBy[] = [];

  const satisfied = segments.every((segment) => {
    if (segment.resolution?.policyBlocked === true) {
      segmentSatisfiedBy.push(null);
      return false;
    }
    const effectiveArgv =
      segment.resolution?.effectiveArgv && segment.resolution.effectiveArgv.length > 0
        ? segment.resolution.effectiveArgv
        : segment.argv;
    const candidatePath = resolveAllowlistCandidatePath(segment.resolution, params.cwd);
    const candidateResolution =
      candidatePath && segment.resolution
        ? { ...segment.resolution, resolvedPath: candidatePath }
        : segment.resolution;
    const match = matchAllowlist(params.allowlist, candidateResolution);
    if (match) {
      matches.push(match);
    }
    const safe = isSafeBinUsage({
      argv: effectiveArgv,
      resolution: segment.resolution,
      safeBins: params.safeBins,
      safeBinProfiles: params.safeBinProfiles,
      platform: params.platform,
      trustedSafeBinDirs: params.trustedSafeBinDirs,
    });
    const rawExecutable = segment.resolution?.rawExecutable?.trim() ?? "";
    const executableName = segment.resolution?.executableName;
    const usesExplicitPath = isPathScopedExecutableToken(rawExecutable);
    let skillAllow = false;
    if (
      allowSkills &&
      segment.resolution?.resolvedPath &&
      rawExecutable.length > 0 &&
      !usesExplicitPath &&
      executableName
    ) {
      skillAllow = Boolean(params.skillBins?.has(executableName));
    }
    const by: ExecSegmentSatisfiedBy = match
      ? "allowlist"
      : safe
        ? "safeBins"
        : skillAllow
          ? "skills"
          : null;
    segmentSatisfiedBy.push(by);
    return Boolean(by);
  });

  return { satisfied, matches, segmentSatisfiedBy };
}

function resolveAnalysisSegmentGroups(analysis: ExecCommandAnalysis): ExecCommandSegment[][] {
  if (analysis.chains) {
    return analysis.chains;
  }
  return [analysis.segments];
}

export function evaluateExecAllowlist(params: {
  analysis: ExecCommandAnalysis;
  allowlist: ExecAllowlistEntry[];
  safeBins: Set<string>;
  safeBinProfiles?: Readonly<Record<string, SafeBinProfile>>;
  cwd?: string;
  platform?: string | null;
  trustedSafeBinDirs?: ReadonlySet<string>;
  skillBins?: Set<string>;
  autoAllowSkills?: boolean;
}): ExecAllowlistEvaluation {
  const allowlistMatches: ExecAllowlistEntry[] = [];
  const segmentSatisfiedBy: ExecSegmentSatisfiedBy[] = [];
  if (!params.analysis.ok || params.analysis.segments.length === 0) {
    return { allowlistSatisfied: false, allowlistMatches, segmentSatisfiedBy };
  }

  const hasChains = Boolean(params.analysis.chains);
  for (const group of resolveAnalysisSegmentGroups(params.analysis)) {
    const result = evaluateSegments(group, {
      allowlist: params.allowlist,
      safeBins: params.safeBins,
      safeBinProfiles: params.safeBinProfiles,
      cwd: params.cwd,
      platform: params.platform,
      trustedSafeBinDirs: params.trustedSafeBinDirs,
      skillBins: params.skillBins,
      autoAllowSkills: params.autoAllowSkills,
    });
    if (!result.satisfied) {
      if (!hasChains) {
        return {
          allowlistSatisfied: false,
          allowlistMatches: result.matches,
          segmentSatisfiedBy: result.segmentSatisfiedBy,
        };
      }
      return { allowlistSatisfied: false, allowlistMatches: [], segmentSatisfiedBy: [] };
    }
    allowlistMatches.push(...result.matches);
    segmentSatisfiedBy.push(...result.segmentSatisfiedBy);
  }
  return { allowlistSatisfied: true, allowlistMatches, segmentSatisfiedBy };
}

export type ExecAllowlistAnalysis = {
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  allowlistMatches: ExecAllowlistEntry[];
  segments: ExecCommandSegment[];
  segmentSatisfiedBy: ExecSegmentSatisfiedBy[];
};

function hasSegmentExecutableMatch(
  segment: ExecCommandSegment,
  predicate: (token: string) => boolean,
): boolean {
  const candidates = [
    segment.resolution?.executableName,
    segment.resolution?.rawExecutable,
    segment.argv[0],
  ];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (!trimmed) {
      continue;
    }
    if (predicate(trimmed)) {
      return true;
    }
  }
  return false;
}

function isShellWrapperSegment(segment: ExecCommandSegment): boolean {
  return hasSegmentExecutableMatch(segment, isShellWrapperExecutable);
}

function isDispatchWrapperSegment(segment: ExecCommandSegment): boolean {
  return hasSegmentExecutableMatch(segment, isDispatchWrapperExecutable);
}

function collectAllowAlwaysPatterns(params: {
  segment: ExecCommandSegment;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
  depth: number;
  out: Set<string>;
}) {
  if (params.depth >= 3) {
    return;
  }

  if (isDispatchWrapperSegment(params.segment)) {
    const dispatchUnwrap = unwrapKnownDispatchWrapperInvocation(params.segment.argv);
    if (dispatchUnwrap.kind !== "unwrapped" || dispatchUnwrap.argv.length === 0) {
      return;
    }
    collectAllowAlwaysPatterns({
      segment: {
        raw: dispatchUnwrap.argv.join(" "),
        argv: dispatchUnwrap.argv,
        resolution: resolveCommandResolutionFromArgv(dispatchUnwrap.argv, params.cwd, params.env),
      },
      cwd: params.cwd,
      env: params.env,
      platform: params.platform,
      depth: params.depth + 1,
      out: params.out,
    });
    return;
  }

  const candidatePath = resolveAllowlistCandidatePath(params.segment.resolution, params.cwd);
  if (!candidatePath) {
    return;
  }
  if (!isShellWrapperSegment(params.segment)) {
    params.out.add(candidatePath);
    return;
  }
  const inlineCommand = extractShellWrapperInlineCommand(params.segment.argv);
  if (!inlineCommand) {
    return;
  }
  const nested = analyzeShellCommand({
    command: inlineCommand,
    cwd: params.cwd,
    env: params.env,
    platform: params.platform,
  });
  if (!nested.ok) {
    return;
  }
  for (const nestedSegment of nested.segments) {
    collectAllowAlwaysPatterns({
      segment: nestedSegment,
      cwd: params.cwd,
      env: params.env,
      platform: params.platform,
      depth: params.depth + 1,
      out: params.out,
    });
  }
}

/**
 * Derive persisted allowlist patterns for an "allow always" decision.
 * When a command is wrapped in a shell (for example `zsh -lc "<cmd>"`),
 * persist the inner executable(s) rather than the shell binary.
 */
export function resolveAllowAlwaysPatterns(params: {
  segments: ExecCommandSegment[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
}): string[] {
  const patterns = new Set<string>();
  for (const segment of params.segments) {
    collectAllowAlwaysPatterns({
      segment,
      cwd: params.cwd,
      env: params.env,
      platform: params.platform,
      depth: 0,
      out: patterns,
    });
  }
  return Array.from(patterns);
}

/**
 * Evaluates allowlist for shell commands (including &&, ||, ;) and returns analysis metadata.
 */
export function evaluateShellAllowlist(params: {
  command: string;
  allowlist: ExecAllowlistEntry[];
  safeBins: Set<string>;
  safeBinProfiles?: Readonly<Record<string, SafeBinProfile>>;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  trustedSafeBinDirs?: ReadonlySet<string>;
  skillBins?: Set<string>;
  autoAllowSkills?: boolean;
  platform?: string | null;
}): ExecAllowlistAnalysis {
  const analysisFailure = (): ExecAllowlistAnalysis => ({
    analysisOk: false,
    allowlistSatisfied: false,
    allowlistMatches: [],
    segments: [],
    segmentSatisfiedBy: [],
  });

  // Keep allowlist analysis conservative: line-continuation semantics are shell-dependent
  // and can rewrite token boundaries at runtime.
  if (hasShellLineContinuation(params.command)) {
    return analysisFailure();
  }

  const chainParts = isWindowsPlatform(params.platform) ? null : splitCommandChain(params.command);
  if (!chainParts) {
    const analysis = analyzeShellCommand({
      command: params.command,
      cwd: params.cwd,
      env: params.env,
      platform: params.platform,
    });
    if (!analysis.ok) {
      return analysisFailure();
    }
    const evaluation = evaluateExecAllowlist({
      analysis,
      allowlist: params.allowlist,
      safeBins: params.safeBins,
      safeBinProfiles: params.safeBinProfiles,
      cwd: params.cwd,
      platform: params.platform,
      trustedSafeBinDirs: params.trustedSafeBinDirs,
      skillBins: params.skillBins,
      autoAllowSkills: params.autoAllowSkills,
    });
    return {
      analysisOk: true,
      allowlistSatisfied: evaluation.allowlistSatisfied,
      allowlistMatches: evaluation.allowlistMatches,
      segments: analysis.segments,
      segmentSatisfiedBy: evaluation.segmentSatisfiedBy,
    };
  }

  const allowlistMatches: ExecAllowlistEntry[] = [];
  const segments: ExecCommandSegment[] = [];
  const segmentSatisfiedBy: ExecSegmentSatisfiedBy[] = [];

  for (const part of chainParts) {
    const analysis = analyzeShellCommand({
      command: part,
      cwd: params.cwd,
      env: params.env,
      platform: params.platform,
    });
    if (!analysis.ok) {
      return analysisFailure();
    }

    segments.push(...analysis.segments);
    const evaluation = evaluateExecAllowlist({
      analysis,
      allowlist: params.allowlist,
      safeBins: params.safeBins,
      safeBinProfiles: params.safeBinProfiles,
      cwd: params.cwd,
      platform: params.platform,
      trustedSafeBinDirs: params.trustedSafeBinDirs,
      skillBins: params.skillBins,
      autoAllowSkills: params.autoAllowSkills,
    });
    allowlistMatches.push(...evaluation.allowlistMatches);
    segmentSatisfiedBy.push(...evaluation.segmentSatisfiedBy);
    if (!evaluation.allowlistSatisfied) {
      return {
        analysisOk: true,
        allowlistSatisfied: false,
        allowlistMatches,
        segments,
        segmentSatisfiedBy,
      };
    }
  }

  return {
    analysisOk: true,
    allowlistSatisfied: true,
    allowlistMatches,
    segments,
    segmentSatisfiedBy,
  };
}
