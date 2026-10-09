import path from "node:path";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { isInterpreterLikeAllowlistPattern } from "./command-analysis/inline-eval.js";
import { detectInlineEvalArgv } from "./command-analysis/risks.js";
import { explainShellCommand } from "./command-explainer/extract.js";
import type { CommandStep } from "./command-explainer/types.js";
import {
  isDispatchWrapperExecutable,
  resolveDispatchWrapperTrustPlan,
  unwrapDispatchWrappersForResolution,
} from "./dispatch-wrapper-resolution.js";
import {
  isWindowsPlatform,
  matchAllowlist,
  buildCwdBoundHashedArgPattern,
  resolveExecutableTrustPath,
  resolveExecutionTargetCandidatePath,
  resolveExecutionTargetResolution,
  resolveExecutionTargetTrustPath,
  resolveCommandResolutionFromArgv,
  resolvePolicyTargetCandidatePath,
  resolvePolicyTargetResolution,
  resolvePolicyTargetTrustPath,
  type ExecCommandAnalysis,
  type ExecCommandSegment,
  type ExecutableResolution,
} from "./exec-approvals-analysis.js";
import type { AllowAlwaysPattern, ExecAllowlistEntry } from "./exec-approvals.types.js";
import {
  canUseReusableWrapperPayloadCandidates,
  planShellAuthorization,
  type ExecAuthorizationPlan,
} from "./exec-authorization-plan.js";
import {
  DEFAULT_SAFE_BINS,
  SAFE_BIN_PROFILES,
  type SafeBinProfile,
  validateSafeBinArgv,
} from "./exec-safe-bin-policy.js";
import { isTrustedSafeBinPath } from "./exec-safe-bin-trust.js";
import { isSafeBuiltinSegment } from "./exec-safe-builtins.js";
import {
  extractBindableShellWrapperInlineCommand,
  isShellWrapperExecutable,
  normalizeExecutableToken,
  POSIX_PARSEABLE_SHELL_WRAPPERS,
  POSIX_SHELL_WRAPPERS,
  POWERSHELL_WRAPPERS,
} from "./exec-wrapper-resolution.js";
import { resolveExecWrapperTrustPlan } from "./exec-wrapper-trust-plan.js";
import { expandHomePrefix } from "./home-dir.js";
import {
  hasKnownPackageManagerExecContextOptions,
  resolveKnownPackageManagerExecInvocation,
} from "./package-manager-exec-wrapper.js";
import {
  advancePosixInlineOptionScan,
  POSIX_INLINE_COMMAND_FLAGS,
  isDirectShellPositionalCarrierCommand,
  isPowerShellInlineFileCommandFlag,
  resolveInlineCommandMatch,
  resolvePowerShellInlineCommandMatch,
} from "./shell-inline-command.js";
import { analyzeWindowsShellCommand } from "./windows-shell-command.js";

function hasShellLineContinuation(command: string): boolean {
  return /\\(?:\r\n|\n|\r)/.test(command);
}

function commandStepToPolicySegment(
  step: CommandStep,
  params: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    platform?: string | null;
  },
): ExecCommandSegment {
  return {
    raw: step.text,
    argv: step.argv,
    resolution: resolveCommandResolutionFromArgv(
      step.argv,
      params.cwd,
      params.env,
      (params.platform ?? undefined) as NodeJS.Platform | undefined,
    ),
  };
}

async function explainShellPolicySegments(params: {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
}): Promise<ExecCommandSegment[]> {
  try {
    const explanation = await explainShellCommand(params.command);
    const steps = [...explanation.topLevelCommands, ...explanation.nestedCommands];
    return steps.map((step) => commandStepToPolicySegment(step, params));
  } catch {
    return [];
  }
}

export function resolveSafeBins(entries?: readonly string[] | null): Set<string> {
  const bins = entries === undefined ? DEFAULT_SAFE_BINS : entries;
  return new Set(
    Array.isArray(bins)
      ? bins.map((entry) => normalizeLowercaseStringOrEmpty(entry)).filter(Boolean)
      : [],
  );
}

function isSafeBinUsage(params: {
  argv: string[];
  resolution: ExecutableResolution | null;
  safeBins: Set<string>;
  platform?: string | null;
  trustedSafeBinDirs?: ReadonlySet<string>;
  safeBinProfiles?: Readonly<Record<string, SafeBinProfile>>;
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
  const trustPath = resolveExecutableTrustPath(resolution);
  if (!trustPath) {
    return false;
  }
  if (
    !isTrustedSafeBinPath({
      resolvedPath: trustPath,
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
  segmentSatisfiedBy: ExecSegmentSatisfiedBy[];
};

export type ExecSegmentSatisfiedBy =
  | "allowlist"
  | "safeBins"
  | "inlineChain"
  | "safeBuiltins"
  | "skills"
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
  allowShellBuiltins?: boolean;
};

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
    const name = normalizeOptionalLowercaseString(entry.name);
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
  const trustPath = resolveExecutionTargetTrustPath(resolution);
  if (!execution?.resolvedPath || !trustPath) {
    return false;
  }
  const rawExecutable = execution.rawExecutable?.trim() ?? "";
  if (!rawExecutable || isPathScopedExecutableToken(rawExecutable)) {
    return false;
  }
  const executableName = normalizeOptionalLowercaseString(execution.executableName);
  const resolvedPath = normalizeSkillBinResolvedPath(trustPath);
  if (!executableName || !resolvedPath) {
    return false;
  }
  return Boolean(params.skillBinTrust.get(executableName)?.has(resolvedPath));
}

const MAX_SHELL_WRAPPER_INLINE_EVAL_DEPTH = 3;

type SegmentMatchEvaluation = {
  effectiveArgv: string[];
  inlineCommand: string | null;
  match: ExecAllowlistEntry | null;
};

const MAX_PACKAGE_MANAGER_EXEC_UNWRAP_DEPTH = 6;

type PackageManagerTrustTarget =
  | { kind: "blocked" }
  | { kind: "not-package-manager"; argv: string[] }
  | { kind: "package-manager"; argv: string[] };

// Package-manager exec keeps the outer argv for process launch, but durable
// approval matching must use the inner trust target so stale outer-wrapper
// allow-always entries cannot authorize a different wrapped payload.
function resolvePackageManagerTrustTargetArgv(
  argv: string[],
  platform: NodeJS.Platform = process.platform,
): PackageManagerTrustTarget {
  let current = argv;
  let sawPackageManagerExec = false;
  for (let depth = 0; depth < MAX_PACKAGE_MANAGER_EXEC_UNWRAP_DEPTH; depth += 1) {
    const dispatchPlan = resolveDispatchWrapperTrustPlan(current, undefined, platform);
    if (dispatchPlan.policyBlocked) {
      return { kind: "blocked" };
    }
    current = dispatchPlan.argv;
    const packageManagerExec = resolveKnownPackageManagerExecInvocation(current);
    if (
      packageManagerExec.kind === "unwrapped" &&
      hasKnownPackageManagerExecContextOptions(current)
    ) {
      return { kind: "blocked" };
    }
    if (packageManagerExec.kind === "unsafe-exec") {
      return { kind: "blocked" };
    }
    if (packageManagerExec.kind !== "unwrapped") {
      return sawPackageManagerExec
        ? { kind: "package-manager", argv: current }
        : { kind: "not-package-manager", argv: current };
    }
    sawPackageManagerExec = true;
    current = packageManagerExec.argv;
  }
  return { kind: "blocked" };
}

function resolvePackageManagerAllowlistTargetArgv(
  argv: string[],
  platform: NodeJS.Platform = process.platform,
): string[] | null | undefined {
  const packageManagerTarget = resolvePackageManagerTrustTargetArgv(argv, platform);
  if (packageManagerTarget.kind === "blocked") {
    return null;
  }
  if (packageManagerTarget.kind !== "package-manager") {
    return undefined;
  }
  const trustPlan = resolveExecWrapperTrustPlan(packageManagerTarget.argv, undefined, platform);
  if (
    trustPlan.policyBlocked ||
    (trustPlan.shellWrapperExecutable && trustPlan.shellInlineCommand)
  ) {
    return null;
  }
  return trustPlan.argv;
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
    left.resolvedRealPath === right.resolvedRealPath &&
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
  const packageManagerTargetArgv = resolvePackageManagerAllowlistTargetArgv(
    effectiveArgv,
    (params.context.platform ?? undefined) as NodeJS.Platform | undefined,
  );
  if (packageManagerTargetArgv === null) {
    return { effectiveArgv, inlineCommand: null, match: null };
  }
  const matchArgv = packageManagerTargetArgv ?? effectiveArgv;
  const matchResolution =
    matchArgv === effectiveArgv
      ? params.segment.resolution
      : resolveCommandResolutionFromArgv(
          matchArgv,
          params.context.cwd,
          params.context.env,
          (params.context.platform ?? undefined) as NodeJS.Platform | undefined,
        );
  const allowlistSegment =
    matchArgv === params.segment.argv
      ? params.segment
      : { ...params.segment, argv: matchArgv, resolution: matchResolution };
  const executableResolution = resolvePolicyTargetResolution(matchResolution);
  const executionResolution = resolveExecutionTargetResolution(params.segment.resolution);
  const candidatePath = resolvePolicyTargetCandidatePath(matchResolution, params.context.cwd);
  const trustPath = resolvePolicyTargetTrustPath(matchResolution, params.context.cwd);
  const candidateResolution =
    candidatePath && executableResolution
      ? { ...executableResolution, resolvedPath: candidatePath, resolvedRealPath: trustPath }
      : executableResolution;
  const matchExecutionResolution = resolveExecutionTargetResolution(matchResolution);
  const inlineCommand = extractBindableShellWrapperInlineCommand(allowlistSegment.argv);
  const opaquePosixShellWrapper = isOpaquePosixShellWrapperSegment(allowlistSegment);
  const powerShellFileScriptArgv = resolvePowerShellFileScriptArgv({
    segment: allowlistSegment,
    cwd: params.context.cwd,
  });
  const isShellWrapperInvocation = isShellWrapperSegment(allowlistSegment);
  const isPositionalCarrierInvocation =
    inlineCommand !== null && isDirectShellPositionalCarrierCommand(inlineCommand);
  const allowlistTargetIsExecutionTarget = executableResolutionsReferToSameTarget(
    executableResolution,
    matchExecutionResolution ?? executionResolution,
  );
  let executableMatch = isPositionalCarrierInvocation
    ? null
    : matchAllowlist(
        params.context.allowlist,
        candidateResolution,
        matchArgv,
        params.context.platform,
        params.context.cwd,
      );
  const hasBoundArgPattern =
    typeof executableMatch?.argPattern === "string" && executableMatch.argPattern.trim().length > 0;
  const isBareWildcardMatch = executableMatch?.pattern?.trim() === "*" && !hasBoundArgPattern;
  const requiresBoundArgPattern =
    allowlistTargetIsExecutionTarget &&
    (inlineCommand !== null || (isShellWrapperInvocation && matchArgv.length > 1));
  if (requiresBoundArgPattern && !hasBoundArgPattern && !isBareWildcardMatch) {
    executableMatch = null;
  }
  const shellPositionalArgvCandidate =
    inlineCommand !== null
      ? resolveShellWrapperPositionalArgvCandidate({
          segment: allowlistSegment,
          cwd: params.context.cwd,
          env: params.context.env,
          platform: params.context.platform,
        })
      : undefined;
  const shellPositionalArgvMatch = shellPositionalArgvCandidate
    ? matchAllowlist(
        shellPositionalArgvCandidate.durable
          ? params.context.allowlist
          : params.context.allowlist.filter((entry) => entry.argPattern === undefined),
        {
          kind: "executable",
          rawExecutable: shellPositionalArgvCandidate.path,
          resolvedPath: shellPositionalArgvCandidate.path,
          resolvedRealPath: resolveCandidateTrustPath(shellPositionalArgvCandidate.path),
          executableName: path.basename(shellPositionalArgvCandidate.path),
        },
        shellPositionalArgvCandidate.argv,
        params.context.platform,
        params.context.cwd,
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
        effectiveArgv: matchArgv,
        cwd: params.context.cwd,
      }))
    : null;
  const shellScriptMatch =
    shellScriptCandidatePath && shellScriptArgv
      ? matchAllowlist(
          params.context.allowlist,
          {
            kind: "executable",
            rawExecutable: shellScriptCandidatePath,
            resolvedPath: shellScriptCandidatePath,
            resolvedRealPath: resolveCandidateTrustPath(shellScriptCandidatePath),
            executableName: path.basename(shellScriptCandidatePath),
          },
          shellScriptArgv,
          params.context.platform,
          params.context.cwd,
        )
      : null;
  return {
    effectiveArgv,
    inlineCommand: powerShellFileScriptArgv || opaquePosixShellWrapper ? null : inlineCommand,
    match: executableMatch ?? shellPositionalArgvMatch ?? shellScriptMatch,
  };
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
  if (
    params.context.allowShellBuiltins === true &&
    isSafeBuiltinSegment({ segment: params.segment, platform: params.context.platform })
  ) {
    return "safeBuiltins";
  }
  const skillAllow = isSkillAutoAllowedSegment({
    segment: params.segment,
    allowSkills: params.allowSkills,
    skillBinTrust: params.skillBinTrust,
  });
  return skillAllow ? "skills" : null;
}

function evaluateShellWrapperInlineCommand(params: {
  inlineCommand: string;
  context: ExecAllowlistContext;
  inlineDepth: number;
}): ExecAllowlistEntry[] | null {
  if (params.inlineDepth >= MAX_SHELL_WRAPPER_INLINE_EVAL_DEPTH) {
    return null;
  }
  if (hasShellLineContinuation(params.inlineCommand)) {
    return null;
  }
  const analysis = analyzeWindowsShellCommand({
    command: params.inlineCommand,
    cwd: params.context.cwd,
    env: params.context.env,
    platform: params.context.platform,
  });
  if (!analysis.ok || analysis.segments.length === 0) {
    return null;
  }

  const matches: ExecAllowlistEntry[] = [];
  for (const group of analysis.chains ?? [analysis.segments]) {
    const result = evaluateSegments(group, params.context, params.inlineDepth);
    if (!result.allowlistSatisfied) {
      return null;
    }
    matches.push(...result.allowlistMatches);
  }
  return matches;
}

function emptyExecAllowlistEvaluation(): ExecAllowlistEvaluation {
  return {
    allowlistSatisfied: false,
    allowlistMatches: [],
    segmentAllowlistEntries: [],
    segmentSatisfiedBy: [],
  };
}

function evaluateSegments(
  segments: ExecCommandSegment[],
  params: ExecAllowlistContext,
  inlineDepth = 0,
): ExecAllowlistEvaluation {
  const result = emptyExecAllowlistEvaluation();
  const { allowlistMatches, segmentAllowlistEntries, segmentSatisfiedBy } = result;
  const skillBinTrust = buildSkillBinTrustIndex(params.skillBins);
  const allowSkills = params.autoAllowSkills === true && skillBinTrust.size > 0;

  result.allowlistSatisfied = segments.every((segment) => {
    if (segment.resolution?.policyBlocked === true) {
      segmentAllowlistEntries.push(null);
      segmentSatisfiedBy.push(null);
      return false;
    }
    const { effectiveArgv, inlineCommand, match } = resolveSegmentAllowlistMatch({
      segment,
      context: params,
    });
    if (match) {
      allowlistMatches.push(match);
    }
    segmentAllowlistEntries.push(match ?? null);
    const by = resolveSegmentSatisfaction({
      match,
      segment,
      effectiveArgv,
      context: params,
      allowSkills,
      skillBinTrust,
    });
    const inlineResult =
      by === null && inlineCommand && isWindowsPlatform(params.platform)
        ? evaluateShellWrapperInlineCommand({
            inlineCommand,
            context: params,
            inlineDepth: inlineDepth + 1,
          })
        : null;
    if (inlineResult) {
      allowlistMatches.push(...inlineResult);
      // Keep per-segment metadata aligned with segments: one satisfaction marker
      // for this wrapper segment, even when the inline payload has multiple parts.
      segmentSatisfiedBy.push("allowlist");
      return true;
    }
    segmentSatisfiedBy.push(by);
    return Boolean(by);
  });

  return result;
}

function evaluateAuthorizationPlan(params: {
  plan: Extract<ExecAuthorizationPlan, { ok: true }>;
  context: ExecAllowlistContext;
}): ExecAllowlistAnalysis {
  const result: ExecAllowlistAnalysis = {
    ...emptyExecAllowlistEvaluation(),
    analysisOk: true,
    allowlistSatisfied: true,
    segments: [],
    authorizationPlan: params.plan,
  };
  const skillBins = params.context.skillBins ?? [];
  const allowSkills = params.context.autoAllowSkills === true && skillBins.length > 0;
  const skillBinTrust = buildSkillBinTrustIndex(skillBins);
  for (const group of params.plan.groups) {
    for (const candidate of group.candidates) {
      let match: ExecAllowlistEntry | null = null;
      let satisfiedBy: ExecSegmentSatisfiedBy = null;
      if (candidate.trustMode !== "prompt-only") {
        const evaluation = resolveSegmentAllowlistMatch({
          segment: candidate.sourceSegment,
          context: params.context,
        });
        match = evaluation.match;
        satisfiedBy = resolveSegmentSatisfaction({
          match,
          segment: candidate.sourceSegment,
          effectiveArgv: evaluation.effectiveArgv,
          context: params.context,
          allowSkills,
          skillBinTrust,
        });
      }
      if (match) {
        result.allowlistMatches.push(match);
      }
      result.segments.push(candidate.sourceSegment);
      result.segmentAllowlistEntries.push(match);
      result.segmentSatisfiedBy.push(satisfiedBy);
      if (!satisfiedBy) {
        result.allowlistSatisfied = false;
      }
    }
  }
  return result;
}

export function evaluateExecAllowlist(
  params: {
    analysis: ExecCommandAnalysis;
  } & ExecAllowlistContext,
): ExecAllowlistEvaluation {
  if (!params.analysis.ok || params.analysis.segments.length === 0) {
    return emptyExecAllowlistEvaluation();
  }
  if (!params.analysis.chains) {
    return evaluateSegments(params.analysis.segments, params);
  }
  const result = emptyExecAllowlistEvaluation();
  for (const group of params.analysis.chains) {
    const groupResult = evaluateSegments(group, params);
    if (!groupResult.allowlistSatisfied) {
      return emptyExecAllowlistEvaluation();
    }
    result.allowlistMatches.push(...groupResult.allowlistMatches);
    result.segmentAllowlistEntries.push(...groupResult.segmentAllowlistEntries);
    result.segmentSatisfiedBy.push(...groupResult.segmentSatisfiedBy);
  }
  result.allowlistSatisfied = true;
  return result;
}

export type ExecAllowlistAnalysis = ExecAllowlistEvaluation & {
  analysisOk: boolean;
  segments: ExecCommandSegment[];
  authorizationPlan?: ExecAuthorizationPlan;
};

function hasSegmentExecutableMatch(
  segment: ExecCommandSegment,
  predicate: (token: string) => boolean,
): boolean {
  const execution = resolveExecutionTargetResolution(segment.resolution);
  const candidates = [execution?.executableName, execution?.rawExecutable, segment.argv[0]];
  return candidates.some((candidate) => {
    const trimmed = normalizeOptionalString(candidate);
    return trimmed ? predicate(trimmed) : false;
  });
}

function isShellWrapperSegment(segment: ExecCommandSegment): boolean {
  return hasSegmentExecutableMatch(segment, isShellWrapperExecutable);
}

function isOpaquePosixShellWrapperSegment(segment: ExecCommandSegment): boolean {
  return hasSegmentExecutableMatch(segment, (token) => {
    const wrapper = normalizeExecutableToken(token);
    return POSIX_SHELL_WRAPPERS.has(wrapper) && !POSIX_PARSEABLE_SHELL_WRAPPERS.has(wrapper);
  });
}

const SHELL_WRAPPER_OPTIONS_WITH_VALUE = new Set(["-c", "--command", "-o", "-O", "+O", "+o"]);
const POSIX_SHELLS_WITH_PLUS_OPTIONS = new Set([
  "ash",
  "bash",
  "dash",
  "ksh",
  "mksh",
  "osh",
  "sh",
  "yash",
  "zsh",
]);

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
  if (isOpaquePosixShellWrapperSegment(params.segment)) {
    return undefined;
  }

  const argv = params.segment.argv;
  if (!Array.isArray(argv) || argv.length < 2) {
    return undefined;
  }

  const wrapperName = normalizeExecutableToken(argv[0] ?? "");
  const isPowerShell = POWERSHELL_WRAPPERS.has(wrapperName);
  const supportsPosixPlusOptions = POSIX_SHELLS_WITH_PLUS_OPTIONS.has(wrapperName);

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
    if (!isPowerShell && POSIX_INLINE_COMMAND_FLAGS.has(token)) {
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
    if (
      !isPowerShell &&
      (token.startsWith("-") || (supportsPosixPlusOptions && token.startsWith("+")))
    ) {
      idx += advancePosixInlineOptionScan(token);
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

type ShellWrapperPositionalArgvCandidate = {
  path: string;
  argv: string[];
  durable: boolean;
};

function isDurableShellPositionalCarrierCommand(command: string, tailArgv: string[]): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return false;
  }

  const shellWhitespace = String.raw`[^\S\r\n]+`;
  const positionalZero = String.raw`(?:\$(?:0|\{0\})|"\$(?:0|\{0\})")`;
  if (tailArgv.length === 0) {
    return new RegExp(
      `^(?:exec${shellWhitespace}(?:--${shellWhitespace})?)?${positionalZero}$`,
      "u",
    ).test(trimmed);
  }

  const positionalAll = String.raw`(?:\$(?:@|\{@\})|"\$(?:@|\{@\})")`;
  return new RegExp(
    `^(?:exec${shellWhitespace}(?:--${shellWhitespace})?)?${positionalZero}${shellWhitespace}${positionalAll}$`,
    "u",
  ).test(trimmed);
}

function resolveShellWrapperPositionalArgvCandidate(params: {
  segment: ExecCommandSegment;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
}): ShellWrapperPositionalArgvCandidate | undefined {
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

  const inlineMatch = resolveInlineCommandMatch(argv, POSIX_INLINE_COMMAND_FLAGS, {
    allowCombinedC: true,
  });
  if (inlineMatch.valueTokenIndex === null || !inlineMatch.command) {
    return undefined;
  }
  if (!isDirectShellPositionalCarrierCommand(inlineMatch.command)) {
    return undefined;
  }

  const carriedOffset = argv
    .slice(inlineMatch.valueTokenIndex + 1)
    .findIndex((token) => token.trim().length > 0);
  if (carriedOffset === -1) {
    return undefined;
  }
  const carriedIndex = inlineMatch.valueTokenIndex + 1 + carriedOffset;
  const carriedExecutable = argv[carriedIndex]?.trim() ?? "";
  if (!carriedExecutable) {
    return undefined;
  }
  const carriedTailArgv = argv.slice(carriedIndex + 1);
  const durable = isDurableShellPositionalCarrierCommand(inlineMatch.command, carriedTailArgv);

  const carriedName = normalizeExecutableToken(carriedExecutable);
  if (isDispatchWrapperExecutable(carriedName) || isShellWrapperExecutable(carriedName)) {
    return undefined;
  }

  const resolution = resolveCommandResolutionFromArgv(
    [carriedExecutable],
    params.cwd,
    params.env,
    (params.platform ?? undefined) as NodeJS.Platform | undefined,
  );
  const candidatePath = resolveExecutionTargetCandidatePath(resolution, params.cwd);
  if (!candidatePath) {
    return undefined;
  }
  const trustPath = resolveCandidateTrustPath(candidatePath) ?? candidatePath;
  return {
    path: candidatePath,
    argv: [trustPath, ...carriedTailArgv],
    durable,
  };
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

function resolveCandidateTrustPath(candidatePath: string | undefined): string | undefined {
  if (!candidatePath) {
    return undefined;
  }
  return resolveExecutableTrustPath({
    kind: "executable",
    rawExecutable: candidatePath,
    resolvedPath: candidatePath,
    executableName: path.basename(candidatePath),
  });
}

function collectAllowAlwaysPatterns(
  inputSegment: ExecCommandSegment,
  params: Omit<Parameters<typeof resolveAllowAlwaysPatternEntries>[0], "segments">,
  depth: number,
  out: AllowAlwaysPattern[],
) {
  if (depth >= 3) {
    return;
  }

  const packageManagerTarget = resolvePackageManagerTrustTargetArgv(
    inputSegment.argv,
    (params.platform ?? undefined) as NodeJS.Platform | undefined,
  );
  if (packageManagerTarget.kind === "blocked") {
    return;
  }
  const trustPlan = resolveExecWrapperTrustPlan(
    packageManagerTarget.argv,
    undefined,
    (params.platform ?? undefined) as NodeJS.Platform | undefined,
  );
  if (trustPlan.policyBlocked) {
    return;
  }
  const segment =
    trustPlan.argv === inputSegment.argv
      ? inputSegment
      : {
          raw: trustPlan.argv.join(" "),
          argv: trustPlan.argv,
          sourceArgv: inputSegment.sourceArgv,
          resolution: resolveCommandResolutionFromArgv(
            trustPlan.argv,
            params.cwd,
            params.env,
            (params.platform ?? undefined) as NodeJS.Platform | undefined,
          ),
        };

  const candidatePath = resolveExecutionTargetTrustPath(segment.resolution, params.cwd);
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
    const argPattern = buildCwdBoundHashedArgPattern(
      segment.argv,
      params.cwd ?? process.cwd(),
      params.platform,
    );
    addAllowAlwaysPattern(out, candidatePath, argPattern);
    return;
  }
  const powerShellFileScriptArgv = resolvePowerShellFileScriptArgv({
    segment,
    cwd: params.cwd,
  });
  const inlineCommand = powerShellFileScriptArgv ? null : trustPlan.shellInlineCommand;
  if (inlineCommand && isOpaquePosixShellWrapperSegment(segment)) {
    return;
  }
  const positionalArgvCandidate =
    inlineCommand !== null
      ? resolveShellWrapperPositionalArgvCandidate({
          segment,
          cwd: params.cwd,
          env: params.env,
          platform: params.platform,
        })
      : undefined;
  if (positionalArgvCandidate) {
    if (!positionalArgvCandidate.durable) {
      return;
    }
    const positionalTrustPath =
      resolveCandidateTrustPath(positionalArgvCandidate.path) ?? positionalArgvCandidate.path;
    const argPattern = buildCwdBoundHashedArgPattern(
      positionalArgvCandidate.argv,
      params.cwd ?? process.cwd(),
      params.platform,
    );
    addAllowAlwaysPattern(out, positionalTrustPath, argPattern);
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
      const scriptTrustPath = resolveCandidateTrustPath(scriptPath) ?? scriptPath;
      const scriptArgv = resolveShellWrapperScriptArgv({
        shellScriptCandidatePath: scriptPath,
        effectiveArgv: powerShellFileScriptArgv ?? segment.argv,
        cwd: params.cwd,
      });
      const argPattern = buildCwdBoundHashedArgPattern(
        scriptArgv,
        params.cwd && params.cwd.trim() ? params.cwd.trim() : process.cwd(),
        params.platform,
      );
      addAllowAlwaysPattern(out, scriptTrustPath, argPattern);
    }
    return;
  }
  if (!isWindowsPlatform(params.platform)) {
    return;
  }
  const nested = analyzeWindowsShellCommand({
    command: inlineCommand,
    cwd: params.cwd,
    env: params.env,
    platform: params.platform,
  });
  if (!nested.ok || !canUseReusableWrapperPayloadCandidates(nested.segments)) {
    return;
  }
  for (const nestedSegment of nested.segments) {
    collectAllowAlwaysPatterns(nestedSegment, params, depth + 1, out);
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
    collectAllowAlwaysPatterns(segment, params, 0, patterns);
  }
  return patterns;
}

export async function evaluateShellAllowlistWithAuthorization(
  params: {
    command: string;
    env?: NodeJS.ProcessEnv;
  } & ExecAllowlistContext,
): Promise<ExecAllowlistAnalysis> {
  if (isWindowsPlatform(params.platform)) {
    // Shell line continuations can rewrite token boundaries at runtime.
    const analysis = hasShellLineContinuation(params.command)
      ? undefined
      : analyzeWindowsShellCommand(params);
    if (!analysis?.ok) {
      return { analysisOk: false, ...emptyExecAllowlistEvaluation(), segments: [] };
    }
    return {
      analysisOk: true,
      ...evaluateExecAllowlist({ ...params, analysis, allowShellBuiltins: true }),
      segments: analysis.segments,
    };
  }
  const allowlistContext = { ...params, allowShellBuiltins: true };
  const authorizationPlan = await planShellAuthorization({ ...params });
  if (!authorizationPlan.ok) {
    return {
      analysisOk: false,
      ...emptyExecAllowlistEvaluation(),
      segments: await explainShellPolicySegments({ ...params }),
      authorizationPlan,
    };
  }
  return evaluateAuthorizationPlan({
    plan: authorizationPlan,
    context: allowlistContext,
  });
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
