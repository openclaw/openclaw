import path from "node:path";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { isInterpreterLikeAllowlistPattern } from "./command-analysis/inline-eval.js";
import { detectInlineEvalArgv } from "./command-analysis/risks.js";
import {
  createExecCommandAnalysisFromAuthorizationPlan,
  planCommandForAuthorization,
  type CommandAuthorizationChainOperator,
  type CommandAuthorizationPlan,
  type CommandAuthorizationTree,
  type CommandAuthorizationUnit,
} from "./command-authorization/index.js";
import {
  isDispatchWrapperExecutable,
  unwrapDispatchWrappersForResolution,
} from "./dispatch-wrapper-resolution.js";
import {
  analyzeShellCommand,
  isWindowsPlatform,
  matchAllowlist,
  resolveExecutionTargetCandidatePath,
  resolveExecutionTargetResolution,
  resolveCommandResolutionFromArgv,
  resolvePolicyTargetCandidatePath,
  resolvePolicyTargetResolution,
  type ExecCommandAnalysis,
  type ExecCommandSegment,
  type ExecutableResolution,
} from "./exec-approvals-analysis.js";
import type { ExecAllowlistEntry, ExecAllowlistPinnedArgvToken } from "./exec-approvals.types.js";
import {
  DEFAULT_SAFE_BINS,
  SAFE_BIN_PROFILES,
  type SafeBinProfile,
  validateSafeBinArgv,
} from "./exec-safe-bin-policy.js";
import { isTrustedSafeBinPath } from "./exec-safe-bin-trust.js";
import {
  extractBindableShellWrapperInlineCommand,
  isShellWrapperExecutable,
  normalizeExecutableToken,
  POSIX_SHELL_WRAPPERS,
  POWERSHELL_WRAPPERS,
} from "./exec-wrapper-resolution.js";
import { resolveExecWrapperTrustPlan } from "./exec-wrapper-trust-plan.js";
import { expandHomePrefix } from "./home-dir.js";
import {
  POSIX_INLINE_COMMAND_FLAGS,
  isPowerShellInlineFileCommandFlag,
  resolveInlineCommandMatch,
  resolvePowerShellInlineCommandMatch,
} from "./shell-inline-command.js";

function hasShellLineContinuation(command: string): boolean {
  return /\\(?:\r\n|\n|\r)/.test(command);
}

export function normalizeSafeBins(entries?: readonly string[]): Set<string> {
  if (!Array.isArray(entries)) {
    return new Set();
  }
  const normalized = entries
    .map((entry) => normalizeLowercaseStringOrEmpty(entry))
    .filter((entry) => entry.length > 0);
  return new Set(normalized);
}

export function resolveSafeBins(entries?: readonly string[] | null): Set<string> {
  if (entries === undefined) {
    return normalizeSafeBins(DEFAULT_SAFE_BINS);
  }
  return normalizeSafeBins(entries ?? []);
}

export function isSafeBinUsage(params: {
  argv: string[];
  resolution: ExecutableResolution | null;
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
  const execName = normalizeOptionalLowercaseString(resolution?.executableName);
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
  return validateSafeBinArgv(argv, profile, { binName: execName });
}

function isPathScopedExecutableToken(token: string): boolean {
  return token.includes("/") || token.includes("\\");
}

export type ExecAllowlistEvaluation = {
  allowlistSatisfied: boolean;
  allowlistMatches: ExecAllowlistEntry[];
  segmentAllowlistEntries: Array<ExecAllowlistEntry | null>;
  segmentPinnedArgvTokens: Array<ExecAllowlistPinnedArgvToken | null>;
  segmentSatisfiedBy: ExecSegmentSatisfiedBy[];
};

export type ExecSegmentSatisfiedBy =
  | "allowlist"
  | "safeBins"
  | "inlineChain"
  | "skills"
  | "skillPrelude"
  | null;
export type SkillBinTrustEntry = {
  name: string;
  resolvedPath: string;
};
type ExecAllowlistContext = {
  allowlist: ExecAllowlistEntry[];
  safeBins: Set<string>;
  safeBinProfiles?: Readonly<Record<string, SafeBinProfile>>;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
  trustedSafeBinDirs?: ReadonlySet<string>;
  skillBins?: readonly SkillBinTrustEntry[];
  autoAllowSkills?: boolean;
};

function pickExecAllowlistContext(params: ExecAllowlistContext): ExecAllowlistContext {
  return {
    allowlist: params.allowlist,
    safeBins: params.safeBins,
    safeBinProfiles: params.safeBinProfiles,
    cwd: params.cwd,
    env: params.env,
    platform: params.platform,
    trustedSafeBinDirs: params.trustedSafeBinDirs,
    skillBins: params.skillBins,
    autoAllowSkills: params.autoAllowSkills,
  };
}

function normalizeSkillBinName(value: string | undefined): string | null {
  const trimmed = normalizeOptionalLowercaseString(value);
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function normalizeSkillBinResolvedPath(value: string | undefined): string | null {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return null;
  }
  const resolved = path.resolve(trimmed);
  if (process.platform === "win32") {
    return normalizeLowercaseStringOrEmpty(resolved.replace(/\\/g, "/"));
  }
  return resolved;
}

function buildSkillBinTrustIndex(
  entries: readonly SkillBinTrustEntry[] | undefined,
): Map<string, Set<string>> {
  const trustByName = new Map<string, Set<string>>();
  if (!entries || entries.length === 0) {
    return trustByName;
  }
  for (const entry of entries) {
    const name = normalizeSkillBinName(entry.name);
    const resolvedPath = normalizeSkillBinResolvedPath(entry.resolvedPath);
    if (!name || !resolvedPath) {
      continue;
    }
    const paths = trustByName.get(name) ?? new Set<string>();
    paths.add(resolvedPath);
    trustByName.set(name, paths);
  }
  return trustByName;
}

function isSkillAutoAllowedSegment(params: {
  segment: ExecCommandSegment;
  allowSkills: boolean;
  skillBinTrust: ReadonlyMap<string, ReadonlySet<string>>;
}): boolean {
  if (!params.allowSkills) {
    return false;
  }
  const resolution = params.segment.resolution;
  const execution = resolveExecutionTargetResolution(resolution);
  if (!execution?.resolvedPath) {
    return false;
  }
  const rawExecutable = execution.rawExecutable?.trim() ?? "";
  if (!rawExecutable || isPathScopedExecutableToken(rawExecutable)) {
    return false;
  }
  const executableName = normalizeSkillBinName(execution.executableName);
  const resolvedPath = normalizeSkillBinResolvedPath(execution.resolvedPath);
  if (!executableName || !resolvedPath) {
    return false;
  }
  return Boolean(params.skillBinTrust.get(executableName)?.has(resolvedPath));
}

function resolveSkillPreludePath(rawPath: string, cwd?: string): string {
  const expanded = rawPath.startsWith("~") ? expandHomePrefix(rawPath) : rawPath;
  if (path.isAbsolute(expanded)) {
    return path.resolve(expanded);
  }
  return path.resolve(cwd?.trim() || process.cwd(), expanded);
}

function isSkillMarkdownPreludePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const lowerNormalized = normalizeLowercaseStringOrEmpty(normalized);
  if (!lowerNormalized.endsWith("/skill.md")) {
    return false;
  }
  const parts = lowerNormalized.split("/").filter(Boolean);
  if (parts.length < 2) {
    return false;
  }
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    if (parts[index] !== "skills") {
      continue;
    }
    const segmentsAfterSkills = parts.length - index - 1;
    if (segmentsAfterSkills === 1 || segmentsAfterSkills === 2) {
      return true;
    }
  }
  return false;
}

function resolveSkillMarkdownPreludeId(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, "/");
  const lowerNormalized = normalizeLowercaseStringOrEmpty(normalized);
  if (!lowerNormalized.endsWith("/skill.md")) {
    return null;
  }
  const parts = lowerNormalized.split("/").filter(Boolean);
  if (parts.length < 3) {
    return null;
  }
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    if (parts[index] !== "skills") {
      continue;
    }
    if (parts.length - index - 1 !== 2) {
      continue;
    }
    const skillId = parts[index + 1]?.trim();
    return skillId || null;
  }
  return null;
}

function isSkillPreludeReadSegment(segment: ExecCommandSegment, cwd?: string): boolean {
  const execution = resolveExecutionTargetResolution(segment.resolution);
  if (normalizeLowercaseStringOrEmpty(execution?.executableName) !== "cat") {
    return false;
  }
  // Keep the display-prelude exception narrow: only a plain `cat <...>/SKILL.md`
  // qualifies, not extra argv forms or arbitrary file reads.
  if (segment.argv.length !== 2) {
    return false;
  }
  const rawPath = segment.argv[1]?.trim();
  if (!rawPath) {
    return false;
  }
  return isSkillMarkdownPreludePath(resolveSkillPreludePath(rawPath, cwd));
}

function isSkillPreludeMarkerSegment(segment: ExecCommandSegment): boolean {
  const execution = resolveExecutionTargetResolution(segment.resolution);
  if (normalizeLowercaseStringOrEmpty(execution?.executableName) !== "printf") {
    return false;
  }
  if (segment.argv.length !== 2) {
    return false;
  }
  const marker = segment.argv[1];
  return marker === "\\n---CMD---\\n" || marker === "\n---CMD---\n";
}

function isSkillPreludeSegment(segment: ExecCommandSegment, cwd?: string): boolean {
  return isSkillPreludeReadSegment(segment, cwd) || isSkillPreludeMarkerSegment(segment);
}

function isSkillPreludeOnlyEvaluation(
  segments: ExecCommandSegment[],
  cwd: string | undefined,
): boolean {
  return segments.length > 0 && segments.every((segment) => isSkillPreludeSegment(segment, cwd));
}

function resolveSkillPreludeIds(
  segments: ExecCommandSegment[],
  cwd: string | undefined,
): ReadonlySet<string> {
  const skillIds = new Set<string>();
  for (const segment of segments) {
    if (!isSkillPreludeReadSegment(segment, cwd)) {
      continue;
    }
    const rawPath = segment.argv[1]?.trim();
    if (!rawPath) {
      continue;
    }
    const skillId = resolveSkillMarkdownPreludeId(resolveSkillPreludePath(rawPath, cwd));
    if (skillId) {
      skillIds.add(skillId);
    }
  }
  return skillIds;
}

function resolveAllowlistedSkillWrapperId(segment: ExecCommandSegment): string | null {
  const execution = resolveExecutionTargetResolution(segment.resolution);
  const executableName = normalizeExecutableToken(
    execution?.executableName ?? segment.argv[0] ?? "",
  );
  if (!executableName.endsWith("-wrapper")) {
    return null;
  }
  const skillId = executableName.slice(0, -"-wrapper".length).trim();
  return skillId || null;
}

function resolveTrustedSkillExecutionIds(params: {
  analysis: ExecCommandAnalysis;
  evaluation: ExecAllowlistEvaluation;
}): ReadonlySet<string> {
  const skillIds = new Set<string>();
  if (!params.evaluation.allowlistSatisfied) {
    return skillIds;
  }
  for (const [index, segment] of params.analysis.segments.entries()) {
    const satisfiedBy = params.evaluation.segmentSatisfiedBy[index];
    if (satisfiedBy === "skills") {
      const execution = resolveExecutionTargetResolution(segment.resolution);
      const executableName = normalizeExecutableToken(
        execution?.executableName ?? execution?.rawExecutable ?? segment.argv[0] ?? "",
      );
      if (executableName) {
        skillIds.add(executableName);
      }
      continue;
    }
    if (satisfiedBy !== "allowlist") {
      continue;
    }
    const wrapperSkillId = resolveAllowlistedSkillWrapperId(segment);
    if (wrapperSkillId) {
      skillIds.add(wrapperSkillId);
    }
  }
  return skillIds;
}

const MAX_SHELL_WRAPPER_INLINE_EVAL_DEPTH = 3;

type InlineChainAllowlistEvaluation = {
  matches: ExecAllowlistEntry[];
  satisfiedBy: "allowlist" | "inlineChain";
};

type SegmentMatchEvaluation = {
  effectiveArgv: string[];
  inlineCommand: string | null;
  match: ExecAllowlistEntry | null;
  pinnedArgvToken: ExecAllowlistPinnedArgvToken | null;
};

const SEMANTICS_NEUTRAL_ALLOW_ALWAYS_WRAPPERS = new Set(["env", "nice"]);

function matchExecutableAllowlistForSegment(params: {
  allowlist: ExecAllowlistEntry[];
  candidateResolution: ExecutableResolution | null;
  effectiveArgv: string[];
  platform?: string | null;
  inlineCommand: string | null;
  isShellWrapperInvocation: boolean;
  isPositionalCarrierInvocation: boolean;
  allowlistTargetIsExecutionTarget: boolean;
}): ExecAllowlistEntry | null {
  if (params.isPositionalCarrierInvocation) {
    return null;
  }
  const match = matchAllowlist(
    params.allowlist,
    params.candidateResolution,
    params.effectiveArgv,
    params.platform,
  );
  const hasBoundArgPattern =
    typeof match?.argPattern === "string" && match.argPattern.trim().length > 0;
  const isBareWildcardMatch = match?.pattern?.trim() === "*" && !hasBoundArgPattern;
  const requiresBoundArgPattern =
    params.allowlistTargetIsExecutionTarget &&
    (params.inlineCommand !== null ||
      (params.isShellWrapperInvocation && params.effectiveArgv.length > 1));
  if (requiresBoundArgPattern && !hasBoundArgPattern && !isBareWildcardMatch) {
    return null;
  }
  return match;
}

function executableResolutionsReferToSameTarget(
  left: ExecutableResolution | null,
  right: ExecutableResolution | null,
): boolean {
  if (!left || !right) {
    return false;
  }
  return (
    left.rawExecutable === right.rawExecutable &&
    left.resolvedPath === right.resolvedPath &&
    left.executableName === right.executableName
  );
}

function resolveShellWrapperScriptArgv(params: {
  shellScriptCandidatePath: string;
  effectiveArgv: string[];
  cwd?: string;
}): string[] {
  const scriptBase = normalizeLowercaseStringOrEmpty(
    path.basename(params.shellScriptCandidatePath),
  );
  const cwdBase = params.cwd && params.cwd.trim() ? params.cwd.trim() : process.cwd();
  const resolveArgPath = (a: string): string => (path.isAbsolute(a) ? a : path.resolve(cwdBase, a));
  let idx = params.effectiveArgv.findIndex(
    (a) => resolveArgPath(a) === params.shellScriptCandidatePath,
  );
  if (idx === -1) {
    idx = params.effectiveArgv.findIndex(
      (a) => normalizeLowercaseStringOrEmpty(path.basename(a)) === scriptBase,
    );
  }
  const scriptArgs = idx !== -1 ? params.effectiveArgv.slice(idx + 1) : [];
  return [params.shellScriptCandidatePath, ...scriptArgs];
}

function resolvePowerShellFileScriptArgv(params: {
  segment: ExecCommandSegment;
  cwd?: string;
}): string[] | null {
  const argv = resolveSegmentSourceArgv(params.segment);
  if (!Array.isArray(argv) || argv.length < 3) {
    return null;
  }
  const wrapperName = normalizeExecutableToken(argv[0] ?? "");
  if (!POWERSHELL_WRAPPERS.has(wrapperName)) {
    return null;
  }

  const match = resolvePowerShellInlineCommandMatch(argv);
  if (match.valueTokenIndex === null || !match.command) {
    return null;
  }
  if (!isPowerShellInlineFileCommandFlag(argv[match.valueTokenIndex - 1] ?? "")) {
    return null;
  }

  const scriptToken = argv[match.valueTokenIndex]?.trim();
  if (!scriptToken) {
    return null;
  }
  const expanded = scriptToken.startsWith("~") ? expandHomePrefix(scriptToken) : scriptToken;
  const base = params.cwd && params.cwd.trim().length > 0 ? params.cwd : process.cwd();
  const scriptPath = path.isAbsolute(expanded) ? expanded : path.resolve(base, expanded);
  return [scriptPath, ...argv.slice(match.valueTokenIndex + 1)];
}

function resolveSegmentSourceArgv(segment: ExecCommandSegment): string[] {
  const sourceArgv = segment.sourceArgv;
  if (!Array.isArray(sourceArgv) || sourceArgv.length === 0) {
    return segment.argv;
  }

  const segmentExecutable = normalizeExecutableToken(segment.argv[0] ?? "");
  if (!segmentExecutable) {
    return segment.argv;
  }
  if (normalizeExecutableToken(sourceArgv[0] ?? "") === segmentExecutable) {
    return sourceArgv;
  }

  const unwrappedSourceArgv = unwrapDispatchWrappersForResolution(sourceArgv);
  return normalizeExecutableToken(unwrappedSourceArgv[0] ?? "") === segmentExecutable
    ? unwrappedSourceArgv
    : segment.argv;
}

function resolveSegmentAllowlistMatch(params: {
  segment: ExecCommandSegment;
  context: ExecAllowlistContext;
}): SegmentMatchEvaluation {
  const effectiveArgv =
    params.segment.resolution?.effectiveArgv && params.segment.resolution.effectiveArgv.length > 0
      ? params.segment.resolution.effectiveArgv
      : params.segment.argv;
  const allowlistSegment =
    effectiveArgv === params.segment.argv
      ? params.segment
      : { ...params.segment, argv: effectiveArgv };
  const executableResolution = resolvePolicyTargetResolution(params.segment.resolution);
  const executionResolution = resolveExecutionTargetResolution(params.segment.resolution);
  const candidatePath = resolvePolicyTargetCandidatePath(
    params.segment.resolution,
    params.context.cwd,
  );
  const candidateResolution =
    candidatePath && executableResolution
      ? { ...executableResolution, resolvedPath: candidatePath }
      : executableResolution;
  const inlineCommand = extractBindableShellWrapperInlineCommand(allowlistSegment.argv);
  const powerShellFileScriptArgv = resolvePowerShellFileScriptArgv({
    segment: allowlistSegment,
    cwd: params.context.cwd,
  });
  const isShellWrapperInvocation = isShellWrapperSegment(allowlistSegment);
  const isPositionalCarrierInvocation =
    inlineCommand !== null && isDirectShellPositionalCarrierInvocation(inlineCommand);
  const executableMatch = matchExecutableAllowlistForSegment({
    allowlist: params.context.allowlist,
    candidateResolution,
    effectiveArgv,
    platform: params.context.platform,
    inlineCommand,
    isShellWrapperInvocation,
    isPositionalCarrierInvocation,
    allowlistTargetIsExecutionTarget: executableResolutionsReferToSameTarget(
      executableResolution,
      executionResolution,
    ),
  });
  const shellPositionalArgvCandidate =
    inlineCommand !== null
      ? resolveShellWrapperPositionalArgvCandidate({
          segment: allowlistSegment,
          cwd: params.context.cwd,
          env: params.context.env,
          trustedSafeBinDirs: params.context.trustedSafeBinDirs,
        })
      : undefined;
  const shellPositionalPinnedArgvToken = shellPositionalArgvCandidate
    ? resolveSourcePinnedArgvToken({
        sourceArgv: params.segment.argv,
        effectiveArgv,
        effectiveTokenIndex: shellPositionalArgvCandidate.tokenIndex,
        replacement: shellPositionalArgvCandidate.path,
      })
    : null;
  const shellPositionalArgvMatch =
    shellPositionalArgvCandidate && shellPositionalPinnedArgvToken
      ? matchAllowlist(
          params.context.allowlist,
          {
            rawExecutable: shellPositionalArgvCandidate.path,
            resolvedPath: shellPositionalArgvCandidate.resolvedPath,
            ...(shellPositionalArgvCandidate.resolvedRealPath
              ? { resolvedRealPath: shellPositionalArgvCandidate.resolvedRealPath }
              : {}),
            executableName: shellPositionalArgvCandidate.executableName,
          },
          undefined,
          params.context.platform,
        )
      : null;
  const shellScriptCandidatePath =
    powerShellFileScriptArgv?.[0] ??
    (inlineCommand === null
      ? resolveShellWrapperScriptCandidatePath({
          segment: allowlistSegment,
          cwd: params.context.cwd,
        })
      : undefined);
  const shellScriptArgv = shellScriptCandidatePath
    ? (powerShellFileScriptArgv ??
      resolveShellWrapperScriptArgv({
        shellScriptCandidatePath,
        effectiveArgv,
        cwd: params.context.cwd,
      }))
    : null;
  const shellScriptMatch =
    shellScriptCandidatePath && shellScriptArgv
      ? matchAllowlist(
          params.context.allowlist,
          {
            rawExecutable: shellScriptCandidatePath,
            resolvedPath: shellScriptCandidatePath,
            executableName: path.basename(shellScriptCandidatePath),
          },
          shellScriptArgv,
          params.context.platform,
        )
      : null;
  const match = executableMatch ?? shellPositionalArgvMatch ?? shellScriptMatch;
  const pinnedArgvToken =
    !executableMatch && shellPositionalArgvMatch && shellPositionalPinnedArgvToken
      ? shellPositionalPinnedArgvToken
      : null;
  return {
    effectiveArgv,
    inlineCommand: powerShellFileScriptArgv ? null : inlineCommand,
    match,
    pinnedArgvToken,
  };
}

function resolveSourcePinnedArgvToken(params: {
  sourceArgv: readonly string[];
  effectiveArgv: readonly string[];
  effectiveTokenIndex: number;
  replacement: string;
}): ExecAllowlistPinnedArgvToken | null {
  const sourceTokenIndex = resolveSourceArgvTokenIndex({
    sourceArgv: params.sourceArgv,
    effectiveArgv: params.effectiveArgv,
    effectiveTokenIndex: params.effectiveTokenIndex,
  });
  return sourceTokenIndex === null
    ? null
    : { tokenIndex: sourceTokenIndex, replacement: params.replacement };
}

function resolveSourceArgvTokenIndex(params: {
  sourceArgv: readonly string[];
  effectiveArgv: readonly string[];
  effectiveTokenIndex: number;
}): number | null {
  if (
    params.effectiveTokenIndex < 0 ||
    params.effectiveTokenIndex >= params.effectiveArgv.length ||
    params.effectiveArgv.length === 0 ||
    params.effectiveArgv.length > params.sourceArgv.length
  ) {
    return null;
  }

  let matchStart: number | null = null;
  for (let start = 0; start <= params.sourceArgv.length - params.effectiveArgv.length; start += 1) {
    const matches = params.effectiveArgv.every(
      (token, offset) => params.sourceArgv[start + offset] === token,
    );
    if (!matches) {
      continue;
    }
    if (matchStart !== null) {
      return null;
    }
    matchStart = start;
  }
  return matchStart === null ? null : matchStart + params.effectiveTokenIndex;
}

function resolveSegmentSatisfaction(params: {
  match: ExecAllowlistEntry | null;
  segment: ExecCommandSegment;
  effectiveArgv: string[];
  context: ExecAllowlistContext;
  allowSkills: boolean;
  skillBinTrust: ReadonlyMap<string, ReadonlySet<string>>;
}): ExecSegmentSatisfiedBy {
  if (params.match) {
    return "allowlist";
  }
  const safe = isSafeBinUsage({
    argv: params.effectiveArgv,
    resolution: resolveExecutionTargetResolution(params.segment.resolution),
    safeBins: params.context.safeBins,
    safeBinProfiles: params.context.safeBinProfiles,
    platform: params.context.platform,
    trustedSafeBinDirs: params.context.trustedSafeBinDirs,
  });
  if (safe) {
    return "safeBins";
  }
  const skillAllow = isSkillAutoAllowedSegment({
    segment: params.segment,
    allowSkills: params.allowSkills,
    skillBinTrust: params.skillBinTrust,
  });
  return skillAllow ? "skills" : null;
}

function resolveInlineCommandFallback(params: {
  by: ExecSegmentSatisfiedBy;
  inlineCommand: string | null;
  context: ExecAllowlistContext;
  inlineDepth: number;
}): InlineChainAllowlistEvaluation | null {
  if (params.by !== null || !params.inlineCommand) {
    return null;
  }
  if (!isWindowsPlatform(params.context.platform)) {
    return null;
  }
  return evaluateShellWrapperInlineCommand({
    inlineCommand: params.inlineCommand,
    context: params.context,
    inlineDepth: params.inlineDepth + 1,
  });
}

function evaluateShellWrapperInlineCommand(params: {
  inlineCommand: string;
  context: ExecAllowlistContext;
  inlineDepth: number;
}): InlineChainAllowlistEvaluation | null {
  if (params.inlineDepth >= MAX_SHELL_WRAPPER_INLINE_EVAL_DEPTH) {
    return null;
  }
  if (hasShellLineContinuation(params.inlineCommand)) {
    return null;
  }
  const analysis = analyzeShellCommand({
    command: params.inlineCommand,
    cwd: params.context.cwd,
    env: params.context.env,
    platform: params.context.platform,
  });
  if (!analysis.ok || analysis.segments.length === 0) {
    return null;
  }

  const matches: ExecAllowlistEntry[] = [];
  for (const group of resolveAnalysisSegmentGroups(analysis)) {
    const result = evaluateSegments(group, params.context, params.inlineDepth);
    if (!result.satisfied) {
      return null;
    }
    matches.push(...result.matches);
  }
  return { matches, satisfiedBy: "allowlist" };
}

function evaluateSegments(
  segments: ExecCommandSegment[],
  params: ExecAllowlistContext,
  inlineDepth: number = 0,
): {
  satisfied: boolean;
  matches: ExecAllowlistEntry[];
  segmentAllowlistEntries: Array<ExecAllowlistEntry | null>;
  segmentPinnedArgvTokens: Array<ExecAllowlistPinnedArgvToken | null>;
  segmentSatisfiedBy: ExecSegmentSatisfiedBy[];
} {
  const matches: ExecAllowlistEntry[] = [];
  const skillBinTrust = buildSkillBinTrustIndex(params.skillBins);
  const allowSkills = params.autoAllowSkills === true && skillBinTrust.size > 0;
  const segmentAllowlistEntries: Array<ExecAllowlistEntry | null> = [];
  const segmentPinnedArgvTokens: Array<ExecAllowlistPinnedArgvToken | null> = [];
  const segmentSatisfiedBy: ExecSegmentSatisfiedBy[] = [];

  const satisfied = segments.every((segment) => {
    if (segment.resolution?.policyBlocked === true) {
      segmentAllowlistEntries.push(null);
      segmentPinnedArgvTokens.push(null);
      segmentSatisfiedBy.push(null);
      return false;
    }
    const { effectiveArgv, inlineCommand, match, pinnedArgvToken } = resolveSegmentAllowlistMatch({
      segment,
      context: params,
    });
    if (match) {
      matches.push(match);
    }
    segmentAllowlistEntries.push(match ?? null);
    segmentPinnedArgvTokens.push(pinnedArgvToken);
    const by = resolveSegmentSatisfaction({
      match,
      segment,
      effectiveArgv,
      context: params,
      allowSkills,
      skillBinTrust,
    });
    const inlineResult = resolveInlineCommandFallback({
      by,
      inlineCommand,
      context: params,
      inlineDepth,
    });
    if (inlineResult) {
      matches.push(...inlineResult.matches);
      // Keep per-segment metadata aligned with segments: one satisfaction marker
      // for this wrapper segment, even when the inline payload has multiple parts.
      segmentSatisfiedBy.push(inlineResult.satisfiedBy);
      return true;
    }
    segmentSatisfiedBy.push(by);
    return Boolean(by);
  });

  return {
    satisfied,
    matches,
    segmentAllowlistEntries,
    segmentPinnedArgvTokens,
    segmentSatisfiedBy,
  };
}

function resolveAnalysisSegmentGroups(analysis: ExecCommandAnalysis): ExecCommandSegment[][] {
  if (analysis.chains) {
    return analysis.chains;
  }
  return [analysis.segments];
}

export function evaluateExecAllowlist(
  params: {
    analysis: ExecCommandAnalysis;
  } & ExecAllowlistContext,
): ExecAllowlistEvaluation {
  const allowlistMatches: ExecAllowlistEntry[] = [];
  const segmentAllowlistEntries: Array<ExecAllowlistEntry | null> = [];
  const segmentPinnedArgvTokens: Array<ExecAllowlistPinnedArgvToken | null> = [];
  const segmentSatisfiedBy: ExecSegmentSatisfiedBy[] = [];
  if (!params.analysis.ok || params.analysis.segments.length === 0) {
    return {
      allowlistSatisfied: false,
      allowlistMatches,
      segmentAllowlistEntries,
      segmentPinnedArgvTokens,
      segmentSatisfiedBy,
    };
  }

  const allowlistContext = pickExecAllowlistContext(params);
  const hasChains = Boolean(params.analysis.chains);
  for (const group of resolveAnalysisSegmentGroups(params.analysis)) {
    const result = evaluateSegments(group, allowlistContext);
    if (!result.satisfied) {
      if (!hasChains) {
        return {
          allowlistSatisfied: false,
          allowlistMatches: result.matches,
          segmentAllowlistEntries: result.segmentAllowlistEntries,
          segmentPinnedArgvTokens: result.segmentPinnedArgvTokens,
          segmentSatisfiedBy: result.segmentSatisfiedBy,
        };
      }
      return {
        allowlistSatisfied: false,
        allowlistMatches: [],
        segmentAllowlistEntries: [],
        segmentPinnedArgvTokens: [],
        segmentSatisfiedBy: [],
      };
    }
    allowlistMatches.push(...result.matches);
    segmentAllowlistEntries.push(...result.segmentAllowlistEntries);
    segmentPinnedArgvTokens.push(...result.segmentPinnedArgvTokens);
    segmentSatisfiedBy.push(...result.segmentSatisfiedBy);
  }
  return {
    allowlistSatisfied: true,
    allowlistMatches,
    segmentAllowlistEntries,
    segmentPinnedArgvTokens,
    segmentSatisfiedBy,
  };
}

export type ExecAllowlistAnalysis = {
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  allowlistMatches: ExecAllowlistEntry[];
  segments: ExecCommandSegment[];
  segmentAllowlistEntries: Array<ExecAllowlistEntry | null>;
  segmentPinnedArgvTokens: Array<ExecAllowlistPinnedArgvToken | null>;
  segmentSatisfiedBy: ExecSegmentSatisfiedBy[];
  authorizationPlan?: CommandAuthorizationPlan;
};

export function countAllowAlwaysApprovedSegments(params: {
  plan: CommandAuthorizationPlan;
  segmentSatisfiedBy?: readonly ExecSegmentSatisfiedBy[];
}): number | undefined {
  const segmentSatisfiedBy = params.segmentSatisfiedBy;
  if (
    !segmentSatisfiedBy ||
    segmentSatisfiedBy.length === 0 ||
    params.plan.kind === "unanalyzable"
  ) {
    return undefined;
  }
  const firstMissIndex = segmentSatisfiedBy.findIndex((entry) => entry === null);
  if (firstMissIndex === -1) {
    return segmentSatisfiedBy.length;
  }
  let groupEndIndex = 0;
  for (const groupSize of authorizationTreeGroupSizes(params.plan.tree)) {
    groupEndIndex += groupSize;
    if (firstMissIndex < groupEndIndex) {
      return groupEndIndex;
    }
  }
  return firstMissIndex + 1;
}

function authorizationTreeGroupSizes(tree: CommandAuthorizationTree): number[] {
  if (tree.kind !== "chain") {
    return [authorizationTreeUnitCount(tree)];
  }
  return tree.children.map((child) => authorizationTreeUnitCount(child));
}

function authorizationTreeUnitCount(tree: CommandAuthorizationTree): number {
  if (tree.kind === "unit") {
    return 1;
  }
  return tree.children.reduce((count, child) => count + authorizationTreeUnitCount(child), 0);
}

function hasSegmentExecutableMatch(
  segment: ExecCommandSegment,
  predicate: (token: string) => boolean,
): boolean {
  const execution = resolveExecutionTargetResolution(segment.resolution);
  const candidates = [execution?.executableName, execution?.rawExecutable, segment.argv[0]];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim();
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

const SHELL_WRAPPER_OPTIONS_WITH_VALUE = new Set(["-c", "--command", "-o", "-O", "+O"]);

const SHELL_WRAPPER_DISQUALIFYING_SCRIPT_OPTIONS = [
  "--rcfile",
  "--init-file",
  "--startup-file",
] as const;

function hasDisqualifyingShellWrapperScriptOption(token: string): boolean {
  return SHELL_WRAPPER_DISQUALIFYING_SCRIPT_OPTIONS.some(
    (option) => token === option || token.startsWith(`${option}=`),
  );
}

const POWERSHELL_OPTIONS_WITH_VALUE_RE =
  /^-(?:executionpolicy|ep|windowstyle|w|workingdirectory|wd|inputformat|outputformat|settingsfile|configurationfile|version|v|psconsolefile|pscf|encodedcommand|en|enc|encodedarguments|ea)$/i;

function resolveShellWrapperScriptCandidatePath(params: {
  segment: ExecCommandSegment;
  cwd?: string;
}): string | undefined {
  if (!isShellWrapperSegment(params.segment)) {
    return undefined;
  }

  const argv = params.segment.argv;
  if (!Array.isArray(argv) || argv.length < 2) {
    return undefined;
  }

  const wrapperName = normalizeExecutableToken(argv[0] ?? "");
  const isPowerShell = POWERSHELL_WRAPPERS.has(wrapperName);

  let idx = 1;
  while (idx < argv.length) {
    const token = argv[idx]?.trim() ?? "";
    if (!token) {
      idx += 1;
      continue;
    }
    if (token === "--") {
      idx += 1;
      break;
    }
    if (token === "-c" || token === "--command") {
      return undefined;
    }
    if (!isPowerShell && /^-[^-]*c[^-]*$/i.test(token)) {
      return undefined;
    }
    if (token === "-s" || (!isPowerShell && /^-[^-]*s[^-]*$/i.test(token))) {
      return undefined;
    }
    if (hasDisqualifyingShellWrapperScriptOption(token)) {
      return undefined;
    }
    if (SHELL_WRAPPER_OPTIONS_WITH_VALUE.has(token)) {
      idx += 2;
      continue;
    }
    if (isPowerShell && POWERSHELL_OPTIONS_WITH_VALUE_RE.test(token)) {
      idx += 2;
      continue;
    }
    if (token.startsWith("-") || token.startsWith("+")) {
      idx += 1;
      continue;
    }
    break;
  }

  const scriptToken = argv[idx]?.trim();
  if (!scriptToken) {
    return undefined;
  }
  if (path.isAbsolute(scriptToken)) {
    return scriptToken;
  }

  const expanded = scriptToken.startsWith("~") ? expandHomePrefix(scriptToken) : scriptToken;
  const base = params.cwd && params.cwd.trim().length > 0 ? params.cwd : process.cwd();
  return path.resolve(base, expanded);
}

function resolveShellWrapperPositionalArgvCandidate(params: {
  segment: ExecCommandSegment;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  trustedSafeBinDirs?: ReadonlySet<string>;
}):
  | {
      path: string;
      resolvedPath: string;
      resolvedRealPath?: string;
      executableName: string;
      tokenIndex: number;
    }
  | undefined {
  if (!isShellWrapperSegment(params.segment)) {
    return undefined;
  }

  const argv = params.segment.argv;
  if (!Array.isArray(argv) || argv.length < 4) {
    return undefined;
  }

  const wrapper = normalizeExecutableToken(argv[0] ?? "");
  if (!["ash", "bash", "dash", "fish", "ksh", "sh", "zsh"].includes(wrapper)) {
    return undefined;
  }
  const shellExecution = resolveExecutionTargetResolution(params.segment.resolution);
  const shellPath = shellExecution?.resolvedPath;
  if (
    !shellPath ||
    !isTrustedSafeBinPath({
      resolvedPath: shellPath,
      trustedDirs: params.trustedSafeBinDirs,
    })
  ) {
    return undefined;
  }

  const inlineMatch = resolveInlineCommandMatch(argv, POSIX_INLINE_COMMAND_FLAGS, {
    allowCombinedC: true,
  });
  if (inlineMatch.valueTokenIndex === null || !inlineMatch.command) {
    return undefined;
  }
  const inlineValueTokenIndex = inlineMatch.valueTokenIndex;
  if (!isDirectShellPositionalCarrierInvocation(inlineMatch.command)) {
    return undefined;
  }

  const carriedExecutableIndex = argv.findIndex(
    (token, index) => index > inlineValueTokenIndex && token.trim().length > 0,
  );
  if (carriedExecutableIndex < 0) {
    return undefined;
  }
  const carriedExecutable = argv[carriedExecutableIndex]?.trim();
  if (!carriedExecutable) {
    return undefined;
  }

  const carriedName = normalizeExecutableToken(carriedExecutable);
  if (isDispatchWrapperExecutable(carriedName) || isShellWrapperExecutable(carriedName)) {
    return undefined;
  }

  const resolution = resolveCommandResolutionFromArgv([carriedExecutable], params.cwd, params.env);
  const execution = resolveExecutionTargetResolution(resolution);
  const candidatePath = resolveExecutionTargetCandidatePath(resolution, params.cwd);
  if (!candidatePath) {
    return undefined;
  }
  return {
    path: execution?.resolvedRealPath ?? candidatePath,
    resolvedPath: execution?.resolvedPath ?? candidatePath,
    ...(execution?.resolvedRealPath ? { resolvedRealPath: execution.resolvedRealPath } : {}),
    executableName: execution?.executableName ?? path.basename(candidatePath),
    tokenIndex: carriedExecutableIndex,
  };
}

function isDirectShellPositionalCarrierInvocation(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return false;
  }

  const shellWhitespace = String.raw`[^\S\r\n]+`;
  const positionalZero = String.raw`(?:\$(?:0|\{0\})|"\$(?:0|\{0\})")`;
  const positionalArg = String.raw`(?:\$(?:[@*]|[1-9]|\{[@*1-9]\})|"\$(?:[@*]|[1-9]|\{[@*1-9]\})")`;
  return new RegExp(
    `^(?:exec${shellWhitespace}(?:--${shellWhitespace})?)?${positionalZero}(?:${shellWhitespace}${positionalArg})*$`,
    "u",
  ).test(trimmed);
}

export type AllowAlwaysPattern = {
  pattern: string;
  argPattern?: string;
};

function escapeRegExpLiteral(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildScriptArgPatternFromArgv(
  argv: string[],
  scriptPath: string,
  cwd?: string,
  platform?: string | null,
): string | undefined {
  if (!isWindowsPlatform(platform ?? process.platform)) {
    return undefined;
  }
  const scriptBase = normalizeLowercaseStringOrEmpty(path.basename(scriptPath));
  const base = cwd && cwd.trim() ? cwd.trim() : process.cwd();
  const resolveArgPath = (arg: string): string =>
    path.isAbsolute(arg) ? arg : path.resolve(base, arg);
  let scriptIdx = argv.findIndex((arg) => resolveArgPath(arg) === scriptPath);
  if (scriptIdx === -1) {
    scriptIdx = argv.findIndex(
      (arg) => normalizeLowercaseStringOrEmpty(path.basename(arg)) === scriptBase,
    );
  }
  const scriptArgs = scriptIdx !== -1 ? argv.slice(scriptIdx + 1) : [];
  const normalized = scriptArgs.map((a) => a.replace(/\//g, "\\"));
  if (normalized.length === 0) {
    return "^\x00\x00$";
  }
  return `^${normalized.map(escapeRegExpLiteral).join("\x00")}\x00$`;
}

function buildArgPatternFromArgv(argv: string[], platform?: string | null): string | undefined {
  if (!isWindowsPlatform(platform ?? process.platform)) {
    return undefined;
  }
  const args = argv.slice(1);
  const normalized = args.map((a) => a.replace(/\//g, "\\"));
  if (normalized.length === 0) {
    return "^\x00\x00$";
  }
  const joined = normalized.join("\x00");
  return `^${escapeRegExpLiteral(joined)}\x00$`;
}

function addAllowAlwaysPattern(
  out: AllowAlwaysPattern[],
  pattern: string,
  argPattern?: string,
): void {
  const exists = out.some(
    (p) => p.pattern === pattern && (p.argPattern ?? undefined) === (argPattern ?? undefined),
  );
  if (!exists) {
    out.push({ pattern, argPattern });
  }
}

function isShellBuiltinCommandCarrier(argv: readonly string[]): boolean {
  const executable = normalizeExecutableToken(argv[0] ?? "");
  return executable === "command" || executable === "builtin" || executable === "exec";
}

function collectAllowAlwaysPatterns(params: {
  segment: ExecCommandSegment;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
  strictInlineEval?: boolean;
  depth: number;
  out: AllowAlwaysPattern[];
}) {
  if (params.depth >= 3) {
    return;
  }

  const trustPlan = resolveExecWrapperTrustPlan(params.segment.argv);
  if (trustPlan.policyBlocked) {
    return;
  }
  if (hasSemanticDispatchWrapper(params.segment)) {
    return;
  }
  const segment =
    trustPlan.argv === params.segment.argv
      ? params.segment
      : {
          raw: trustPlan.argv.join(" "),
          argv: trustPlan.argv,
          sourceArgv: params.segment.sourceArgv,
          resolution: resolveCommandResolutionFromArgv(trustPlan.argv, params.cwd, params.env),
        };

  if (isShellBuiltinCommandCarrier(segment.argv)) {
    return;
  }
  if (hasSemanticDispatchWrapper(segment)) {
    return;
  }
  const candidatePath = resolveExecutionTargetCandidatePath(segment.resolution, params.cwd);
  if (!candidatePath) {
    return;
  }
  if (isInterpreterLikeAllowlistPattern(candidatePath)) {
    const effectiveArgv = segment.resolution?.effectiveArgv ?? segment.argv;
    if (params.strictInlineEval !== true || detectInlineEvalArgv(effectiveArgv) !== null) {
      return;
    }
  }
  if (!trustPlan.shellWrapperExecutable) {
    const argPattern = buildArgPatternFromArgv(segment.argv, params.platform);
    addAllowAlwaysPattern(params.out, candidatePath, argPattern);
    return;
  }
  if (hasNonTransparentPosixShellWrapperOption(trustPlan.argv)) {
    return;
  }
  const powerShellFileScriptArgv = resolvePowerShellFileScriptArgv({
    segment,
    cwd: params.cwd,
  });
  const inlineCommand = powerShellFileScriptArgv ? null : trustPlan.shellInlineCommand;
  const positionalArgvCandidate =
    inlineCommand !== null
      ? resolveShellWrapperPositionalArgvCandidate({
          segment,
          cwd: params.cwd,
          env: params.env,
        })
      : undefined;
  if (positionalArgvCandidate) {
    addAllowAlwaysPattern(params.out, positionalArgvCandidate.path);
    return;
  }
  if (!inlineCommand) {
    const scriptPath =
      powerShellFileScriptArgv?.[0] ??
      resolveShellWrapperScriptCandidatePath({
        segment,
        cwd: params.cwd,
      });
    if (scriptPath) {
      const argPattern = buildScriptArgPatternFromArgv(
        powerShellFileScriptArgv ?? params.segment.argv,
        scriptPath,
        params.cwd,
        params.platform,
      );
      addAllowAlwaysPattern(params.out, scriptPath, argPattern);
    }
    return;
  }
}

/**
 * Derive persisted allowlist patterns for an "allow always" decision.
 * When a command is wrapped in a shell (for example `zsh -lc "<cmd>"`),
 * persist the inner executable(s) rather than the shell binary.
 */
export function resolveAllowAlwaysPatternEntries(params: {
  segments: ExecCommandSegment[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
  strictInlineEval?: boolean;
}): AllowAlwaysPattern[] {
  const patterns: AllowAlwaysPattern[] = [];
  for (const segment of params.segments) {
    collectAllowAlwaysPatterns({
      segment,
      cwd: params.cwd,
      env: params.env,
      platform: params.platform,
      strictInlineEval: params.strictInlineEval,
      depth: 0,
      out: patterns,
    });
  }
  return patterns;
}

export function resolveAllowAlwaysPatternEntriesFromPlan(params: {
  plan: CommandAuthorizationPlan;
  approvedSegments?: ExecCommandSegment[];
  approvedSegmentCount?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
  strictInlineEval?: boolean;
}): AllowAlwaysPattern[] {
  if (params.plan.kind === "unanalyzable") {
    return [];
  }

  const approvedSegmentCount =
    params.approvedSegmentCount !== undefined
      ? params.approvedSegmentCount
      : params.approvedSegments !== undefined && params.approvedSegments.length > 0
        ? params.approvedSegments.length
        : params.plan.units.length;
  const segments = resolveAllowAlwaysEligiblePlanSegments({
    units: params.plan.units,
    approvedSegments: params.approvedSegments,
    approvedSegmentCount,
    cwd: params.cwd,
    env: params.env,
  });

  return resolveAllowAlwaysPatternEntries({
    segments,
    cwd: params.cwd,
    env: params.env,
    platform: params.platform,
    strictInlineEval: params.strictInlineEval,
  });
}

function hasSemanticDispatchWrapper(segment: ExecCommandSegment): boolean {
  const wrapperChain = segment.resolution?.wrapperChain;
  return (
    Array.isArray(wrapperChain) &&
    wrapperChain.some((wrapper) => !SEMANTICS_NEUTRAL_ALLOW_ALWAYS_WRAPPERS.has(wrapper))
  );
}

async function collectAllowAlwaysPatternsAsync(params: {
  segment: ExecCommandSegment;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
  strictInlineEval?: boolean;
  depth: number;
  out: AllowAlwaysPattern[];
}): Promise<void> {
  if (params.depth >= 3) {
    return;
  }

  const trustPlan = resolveExecWrapperTrustPlan(params.segment.argv);
  if (trustPlan.policyBlocked) {
    return;
  }
  if (hasSemanticDispatchWrapper(params.segment)) {
    return;
  }
  const segment =
    trustPlan.argv === params.segment.argv
      ? params.segment
      : {
          raw: trustPlan.argv.join(" "),
          argv: trustPlan.argv,
          sourceArgv: params.segment.sourceArgv,
          resolution: resolveCommandResolutionFromArgv(trustPlan.argv, params.cwd, params.env),
        };

  if (isShellBuiltinCommandCarrier(segment.argv)) {
    return;
  }
  if (hasSemanticDispatchWrapper(segment)) {
    return;
  }
  const candidatePath = resolveExecutionTargetCandidatePath(segment.resolution, params.cwd);
  if (!candidatePath) {
    return;
  }
  if (isInterpreterLikeAllowlistPattern(candidatePath)) {
    const effectiveArgv = segment.resolution?.effectiveArgv ?? segment.argv;
    if (params.strictInlineEval !== true || detectInlineEvalArgv(effectiveArgv) !== null) {
      return;
    }
  }
  if (!trustPlan.shellWrapperExecutable) {
    const argPattern = buildArgPatternFromArgv(segment.argv, params.platform);
    addAllowAlwaysPattern(params.out, candidatePath, argPattern);
    return;
  }
  if (hasNonTransparentPosixShellWrapperOption(trustPlan.argv)) {
    return;
  }

  const powerShellFileScriptArgv = resolvePowerShellFileScriptArgv({
    segment,
    cwd: params.cwd,
  });
  const inlineCommand = powerShellFileScriptArgv ? null : trustPlan.shellInlineCommand;
  const positionalArgvCandidate =
    inlineCommand !== null
      ? resolveShellWrapperPositionalArgvCandidate({
          segment,
          cwd: params.cwd,
          env: params.env,
        })
      : undefined;
  if (positionalArgvCandidate) {
    addAllowAlwaysPattern(params.out, positionalArgvCandidate.path);
    return;
  }
  if (!inlineCommand) {
    const scriptPath =
      powerShellFileScriptArgv?.[0] ??
      resolveShellWrapperScriptCandidatePath({
        segment,
        cwd: params.cwd,
      });
    if (scriptPath) {
      const argPattern = buildScriptArgPatternFromArgv(
        powerShellFileScriptArgv ?? params.segment.argv,
        scriptPath,
        params.cwd,
        params.platform,
      );
      addAllowAlwaysPattern(params.out, scriptPath, argPattern);
    }
    return;
  }

  const nestedPlan = await planCommandForAuthorization(
    { dialect: "posix-shell", command: inlineCommand },
    {
      cwd: params.cwd,
      env: params.env,
      platform: params.platform,
    },
  );
  const nestedExecutable =
    nestedPlan.kind === "unanalyzable" ? "" : (nestedPlan.units[0]?.executable ?? "");
  if (isRelativePathScopedExecutableToken(nestedExecutable)) {
    return;
  }
  const nestedAnalysis = createExecCommandAnalysisFromAuthorizationPlan({
    plan: nestedPlan,
    cwd: params.cwd,
    env: params.env,
  });
  for (const nestedSegment of nestedAnalysis?.segments ?? []) {
    await collectAllowAlwaysPatternsAsync({
      segment: nestedSegment,
      cwd: params.cwd,
      env: params.env,
      platform: params.platform,
      strictInlineEval: params.strictInlineEval,
      depth: params.depth + 1,
      out: params.out,
    });
  }
}

function hasNonTransparentPosixShellWrapperOption(argv: readonly string[]): boolean {
  const executable = normalizeExecutableToken(argv[0] ?? "");
  const posixShellWrappers: ReadonlySet<string> = POSIX_SHELL_WRAPPERS;
  if (!posixShellWrappers.has(executable)) {
    return false;
  }

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]?.trim();
    if (!token) {
      continue;
    }
    if (token === "--") {
      return false;
    }
    if (token === "-c" || token === "--command") {
      return false;
    }
    if (token.startsWith("-") || token.startsWith("+")) {
      return true;
    }
    return false;
  }
  return false;
}

function isRelativePathScopedExecutableToken(token: string): boolean {
  if (!token.includes("/") && !token.includes("\\")) {
    return false;
  }
  const normalized = token.replace(/\\/g, "/");
  return (
    !normalized.startsWith("/") && !/^[A-Za-z]:\//u.test(normalized) && !normalized.startsWith("//")
  );
}

function resolveAllowAlwaysEligiblePlanSegments(params: {
  units: readonly CommandAuthorizationUnit[];
  approvedSegments?: readonly ExecCommandSegment[];
  approvedSegmentCount: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): ExecCommandSegment[] {
  const segments: ExecCommandSegment[] = [];
  for (const [index, unit] of params.units.slice(0, params.approvedSegmentCount).entries()) {
    if (!unit.allowAlwaysEligible || unit.blockReasons.length > 0) {
      continue;
    }
    const approvedSegment = params.approvedSegments?.[index];
    if (approvedSegment && argvListsEqual(approvedSegment.argv, unit.argv)) {
      segments.push(approvedSegment);
      continue;
    }
    segments.push({
      raw: unit.raw,
      argv: unit.argv,
      resolution: resolveCommandResolutionFromArgv(unit.argv, params.cwd, params.env),
    });
  }
  return segments;
}

function argvListsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export async function resolveAllowAlwaysPatternEntriesFromPlanAsync(params: {
  plan: CommandAuthorizationPlan;
  approvedSegments?: ExecCommandSegment[];
  approvedSegmentCount?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
  strictInlineEval?: boolean;
}): Promise<AllowAlwaysPattern[]> {
  if (params.plan.kind === "unanalyzable") {
    return [];
  }

  const approvedSegmentCount =
    params.approvedSegmentCount !== undefined
      ? params.approvedSegmentCount
      : params.approvedSegments !== undefined && params.approvedSegments.length > 0
        ? params.approvedSegments.length
        : params.plan.units.length;
  const segments = resolveAllowAlwaysEligiblePlanSegments({
    units: params.plan.units,
    approvedSegments: params.approvedSegments,
    approvedSegmentCount,
    cwd: params.cwd,
    env: params.env,
  });

  const patterns: AllowAlwaysPattern[] = [];
  for (const segment of segments) {
    await collectAllowAlwaysPatternsAsync({
      segment,
      cwd: params.cwd,
      env: params.env,
      platform: params.platform,
      strictInlineEval: params.strictInlineEval,
      depth: 0,
      out: patterns,
    });
  }
  return patterns;
}

export function resolveAllowAlwaysPatterns(params: {
  segments: ExecCommandSegment[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
  strictInlineEval?: boolean;
}): string[] {
  return resolveAllowAlwaysPatternEntries(params).map((pattern) => pattern.pattern);
}

/**
 * Evaluates allowlist for shell commands (including &&, ||, ;) and returns analysis metadata.
 */
export async function evaluateShellAllowlist(
  params: {
    command: string;
    env?: NodeJS.ProcessEnv;
  } & ExecAllowlistContext,
): Promise<ExecAllowlistAnalysis> {
  const allowlistContext = pickExecAllowlistContext(params);
  const analysisFailure = (): ExecAllowlistAnalysis => ({
    analysisOk: false,
    allowlistSatisfied: false,
    allowlistMatches: [],
    segments: [],
    segmentAllowlistEntries: [],
    segmentPinnedArgvTokens: [],
    segmentSatisfiedBy: [],
  });

  if (isWindowsPlatform(params.platform)) {
    const analysis = analyzeShellCommand({
      command: params.command,
      cwd: params.cwd,
      env: params.env,
      platform: params.platform,
    });
    if (!analysis.ok) {
      return analysisFailure();
    }
    const evaluation = evaluateExecAllowlist({ analysis, ...allowlistContext });
    return {
      analysisOk: true,
      allowlistSatisfied: evaluation.allowlistSatisfied,
      allowlistMatches: evaluation.allowlistMatches,
      segments: analysis.segments,
      segmentAllowlistEntries: evaluation.segmentAllowlistEntries,
      segmentPinnedArgvTokens: evaluation.segmentPinnedArgvTokens,
      segmentSatisfiedBy: evaluation.segmentSatisfiedBy,
    };
  }

  const plan = await planCommandForAuthorization(
    { dialect: "posix-shell", command: params.command },
    {
      cwd: params.cwd,
      env: params.env,
      platform: params.platform,
    },
  );
  if (plan.kind === "unanalyzable") {
    return analysisFailure();
  }
  if (hasAnalysisBlockingPromptOnlyReason(plan)) {
    return hasPromptOnlyInlineEval(plan)
      ? (promptOnlyAnalysisMiss({ plan, cwd: params.cwd, env: params.env }) ?? analysisFailure())
      : analysisFailure();
  }

  const plannedGroups = createPlannedAllowlistGroups({
    plan,
    cwd: params.cwd,
    env: params.env,
  });
  if (!plannedGroups) {
    return analysisFailure();
  }

  if (plannedGroups.length === 1) {
    const group = plannedGroups[0];
    if (!group) {
      return analysisFailure();
    }
    if (!plannedAllowlistGroupEligible(group)) {
      return plannedAllowlistGroupMiss({ group, plan });
    }
    const evaluation = evaluateExecAllowlist({ analysis: group.analysis, ...allowlistContext });
    return {
      analysisOk: true,
      allowlistSatisfied: evaluation.allowlistSatisfied,
      allowlistMatches: evaluation.allowlistMatches,
      segments: group.analysis.segments,
      segmentAllowlistEntries: evaluation.segmentAllowlistEntries,
      segmentPinnedArgvTokens: evaluation.segmentPinnedArgvTokens,
      segmentSatisfiedBy: evaluation.segmentSatisfiedBy,
      authorizationPlan: plan,
    };
  }

  const finalizedEvaluations = plannedGroups.map((group) => ({
    analysis: group.analysis,
    evaluation: evaluateExecAllowlist({ analysis: group.analysis, ...allowlistContext }),
    opToNext: group.opToNext,
  }));
  const allowSkillPreludeAtIndex = new Set<number>();
  const reachableSkillIds = new Set<string>();
  // Only allow the `cat SKILL.md && printf ...` display prelude when it sits on a
  // contiguous `&&` chain that actually reaches a later trusted skill-wrapper execution.
  for (let index = finalizedEvaluations.length - 1; index >= 0; index -= 1) {
    const { analysis, evaluation, opToNext } = finalizedEvaluations[index];
    const trustedSkillIds = resolveTrustedSkillExecutionIds({
      analysis,
      evaluation,
    });
    if (trustedSkillIds.size > 0) {
      for (const skillId of trustedSkillIds) {
        reachableSkillIds.add(skillId);
      }
      continue;
    }

    const isPreludeOnly =
      !evaluation.allowlistSatisfied && isSkillPreludeOnlyEvaluation(analysis.segments, params.cwd);
    const preludeSkillIds = isPreludeOnly
      ? resolveSkillPreludeIds(analysis.segments, params.cwd)
      : new Set<string>();
    const reachesTrustedSkillExecution =
      opToNext === "&&" &&
      (preludeSkillIds.size === 0
        ? reachableSkillIds.size > 0
        : [...preludeSkillIds].some((skillId) => reachableSkillIds.has(skillId)));
    if (isPreludeOnly && reachesTrustedSkillExecution) {
      allowSkillPreludeAtIndex.add(index);
      continue;
    }

    reachableSkillIds.clear();
  }
  const allowlistMatches: ExecAllowlistEntry[] = [];
  const segments: ExecCommandSegment[] = [];
  const segmentAllowlistEntries: Array<ExecAllowlistEntry | null> = [];
  const segmentPinnedArgvTokens: Array<ExecAllowlistPinnedArgvToken | null> = [];
  const segmentSatisfiedBy: ExecSegmentSatisfiedBy[] = [];

  for (const [index, { analysis, evaluation }] of finalizedEvaluations.entries()) {
    const group = plannedGroups[index];
    if (!group || !plannedAllowlistGroupEligible(group)) {
      if (group) {
        segments.push(...group.analysis.segments);
        segmentAllowlistEntries.push(...group.analysis.segments.map(() => null));
        segmentPinnedArgvTokens.push(...group.analysis.segments.map(() => null));
        segmentSatisfiedBy.push(...group.analysis.segments.map(() => null));
      }
      appendUnevaluatedPlannedGroups({
        groups: plannedGroups,
        startIndex: index + 1,
        segments,
        segmentAllowlistEntries,
        segmentPinnedArgvTokens,
        segmentSatisfiedBy,
      });
      return {
        analysisOk: true,
        allowlistSatisfied: false,
        allowlistMatches,
        segments,
        segmentAllowlistEntries,
        segmentPinnedArgvTokens,
        segmentSatisfiedBy,
        authorizationPlan: plan,
      };
    }
    const effectiveSegmentSatisfiedBy = allowSkillPreludeAtIndex.has(index)
      ? analysis.segments.map(() => "skillPrelude" as const)
      : evaluation.segmentSatisfiedBy;
    const effectiveSegmentAllowlistEntries = allowSkillPreludeAtIndex.has(index)
      ? analysis.segments.map(() => null)
      : evaluation.segmentAllowlistEntries;
    const effectiveSegmentPinnedArgvTokens = allowSkillPreludeAtIndex.has(index)
      ? analysis.segments.map(() => null)
      : evaluation.segmentPinnedArgvTokens;

    segments.push(...analysis.segments);
    allowlistMatches.push(...evaluation.allowlistMatches);
    segmentAllowlistEntries.push(...effectiveSegmentAllowlistEntries);
    segmentPinnedArgvTokens.push(...effectiveSegmentPinnedArgvTokens);
    segmentSatisfiedBy.push(...effectiveSegmentSatisfiedBy);
    if (!evaluation.allowlistSatisfied && !allowSkillPreludeAtIndex.has(index)) {
      appendUnevaluatedPlannedGroups({
        groups: plannedGroups,
        startIndex: index + 1,
        segments,
        segmentAllowlistEntries,
        segmentPinnedArgvTokens,
        segmentSatisfiedBy,
      });
      return {
        analysisOk: true,
        allowlistSatisfied: false,
        allowlistMatches,
        segments,
        segmentAllowlistEntries,
        segmentPinnedArgvTokens,
        segmentSatisfiedBy,
        authorizationPlan: plan,
      };
    }
  }

  return {
    analysisOk: true,
    allowlistSatisfied: true,
    allowlistMatches,
    segments,
    segmentAllowlistEntries,
    segmentPinnedArgvTokens,
    segmentSatisfiedBy,
    authorizationPlan: plan,
  };
}

function appendUnevaluatedPlannedGroups(params: {
  groups: readonly PlannedAllowlistGroup[];
  startIndex: number;
  segments: ExecCommandSegment[];
  segmentAllowlistEntries: Array<ExecAllowlistEntry | null>;
  segmentPinnedArgvTokens: Array<ExecAllowlistPinnedArgvToken | null>;
  segmentSatisfiedBy: ExecSegmentSatisfiedBy[];
}): void {
  for (let index = params.startIndex; index < params.groups.length; index += 1) {
    const group = params.groups[index];
    if (!group) {
      continue;
    }
    params.segments.push(...group.analysis.segments);
    params.segmentAllowlistEntries.push(...group.analysis.segments.map(() => null));
    params.segmentPinnedArgvTokens.push(...group.analysis.segments.map(() => null));
    params.segmentSatisfiedBy.push(...group.analysis.segments.map(() => null));
  }
}

type PlannedAllowlistGroup = {
  analysis: ExecCommandAnalysis;
  units: CommandAuthorizationUnit[];
  opToNext: CommandAuthorizationChainOperator | null;
};

function plannedAllowlistGroupEligible(group: PlannedAllowlistGroup): boolean {
  return group.units.every((unit) => unit.allowlistEligible && unit.blockReasons.length === 0);
}

function plannedAllowlistGroupMiss(params: {
  group: PlannedAllowlistGroup;
  plan: CommandAuthorizationPlan;
}): ExecAllowlistAnalysis {
  return {
    analysisOk: true,
    allowlistSatisfied: false,
    allowlistMatches: [],
    segments: params.group.analysis.segments,
    segmentAllowlistEntries: params.group.analysis.segments.map(() => null),
    segmentPinnedArgvTokens: params.group.analysis.segments.map(() => null),
    segmentSatisfiedBy: params.group.analysis.segments.map(() => null),
    authorizationPlan: params.plan,
  };
}

function promptOnlyAnalysisMiss(params: {
  plan: CommandAuthorizationPlan;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): ExecAllowlistAnalysis | null {
  const analysis = createExecCommandAnalysisFromAuthorizationPlan({
    plan: params.plan,
    cwd: params.cwd,
    env: params.env,
  });
  if (!analysis) {
    return null;
  }
  return {
    analysisOk: false,
    allowlistSatisfied: false,
    allowlistMatches: [],
    segments: analysis.segments,
    segmentAllowlistEntries: analysis.segments.map(() => null),
    segmentPinnedArgvTokens: analysis.segments.map(() => null),
    segmentSatisfiedBy: analysis.segments.map(() => null),
    authorizationPlan: params.plan,
  };
}

function hasAnalysisBlockingPromptOnlyReason(plan: CommandAuthorizationPlan): boolean {
  return (
    plan.kind === "prompt-only" &&
    plan.promptOnlyReasons.some(
      (reason) =>
        reason === "command-substitution" ||
        reason === "dynamic-executable" ||
        reason === "unsupported-shell-syntax",
    )
  );
}

function hasPromptOnlyInlineEval(plan: CommandAuthorizationPlan): boolean {
  return plan.kind === "prompt-only" && plan.promptOnlyReasons.includes("interpreter-inline-eval");
}

function createPlannedAllowlistGroups(params: {
  plan: CommandAuthorizationPlan;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): PlannedAllowlistGroup[] | null {
  if (params.plan.kind === "unanalyzable") {
    return null;
  }
  const unitsById = new Map(params.plan.units.map((unit) => [unit.id, unit]));
  if (params.plan.tree.kind !== "chain") {
    const analysis = createExecCommandAnalysisFromAuthorizationPlan({
      plan: params.plan,
      cwd: params.cwd,
      env: params.env,
    });
    const units = collectAuthorizationTreeUnits(params.plan.tree, unitsById);
    return analysis && units ? [{ analysis, units, opToNext: null }] : null;
  }

  const groups: PlannedAllowlistGroup[] = [];
  for (const [index, child] of params.plan.tree.children.entries()) {
    const analysis = createExecCommandAnalysisFromAuthorizationPlan({
      plan: params.plan,
      tree: child,
      cwd: params.cwd,
      env: params.env,
    });
    if (!analysis) {
      return null;
    }
    const units = collectAuthorizationTreeUnits(child, unitsById);
    if (!units) {
      return null;
    }
    groups.push({
      analysis,
      units,
      opToNext: params.plan.tree.operators[index] ?? null,
    });
  }
  return groups.length > 0 ? groups : null;
}

function collectAuthorizationTreeUnits(
  tree: CommandAuthorizationTree,
  unitsById: ReadonlyMap<string, CommandAuthorizationUnit>,
): CommandAuthorizationUnit[] | null {
  if (tree.kind === "unit") {
    const unit = unitsById.get(tree.unitId);
    return unit ? [unit] : null;
  }
  const units: CommandAuthorizationUnit[] = [];
  for (const child of tree.children) {
    const childUnits = collectAuthorizationTreeUnits(child, unitsById);
    if (!childUnits) {
      return null;
    }
    units.push(...childUnits);
  }
  return units;
}
