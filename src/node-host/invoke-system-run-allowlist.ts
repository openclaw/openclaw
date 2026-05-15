import {
  renderAuthorizationShellCommand,
  type CommandAuthorizationPlan,
} from "../infra/command-authorization/index.js";
import {
  analyzeArgvCommand,
  evaluateExecAllowlist,
  evaluateShellAllowlist,
  resolvePlannedSegmentArgv,
  resolveExecApprovals,
  type ExecAllowlistEntry,
  type ExecAllowlistPinnedArgvToken,
  type ExecCommandSegment,
  type ExecSegmentSatisfiedBy,
  type ExecSecurity,
  type SkillBinTrustEntry,
} from "../infra/exec-approvals.js";
import { resolveExecSafeBinRuntimePolicy } from "../infra/exec-safe-bin-runtime-policy.js";
import {
  normalizeExecutableToken,
  POSIX_SHELL_WRAPPERS,
  resolveShellWrapperTransportArgv,
} from "../infra/exec-wrapper-resolution.js";
import {
  POSIX_INLINE_COMMAND_FLAGS,
  resolveInlineCommandMatch,
} from "../infra/shell-inline-command.js";
import type { RunResult } from "./invoke-types.js";

const POSIX_SHELL_WRAPPER_NAMES: ReadonlySet<string> = POSIX_SHELL_WRAPPERS;

type SystemRunAllowlistAnalysis = {
  analysisOk: boolean;
  allowlistMatches: ExecAllowlistEntry[];
  allowlistSatisfied: boolean;
  segments: ExecCommandSegment[];
  segmentAllowlistEntries: Array<ExecAllowlistEntry | null>;
  segmentPinnedArgvTokens: Array<ExecAllowlistPinnedArgvToken | null>;
  segmentSatisfiedBy: ExecSegmentSatisfiedBy[];
  authorizationPlan?: CommandAuthorizationPlan;
};

export async function evaluateSystemRunAllowlist(params: {
  shellCommand: string | null;
  argv: string[];
  approvals: ReturnType<typeof resolveExecApprovals>;
  security: ExecSecurity;
  safeBins: ReturnType<typeof resolveExecSafeBinRuntimePolicy>["safeBins"];
  safeBinProfiles: ReturnType<typeof resolveExecSafeBinRuntimePolicy>["safeBinProfiles"];
  trustedSafeBinDirs: ReturnType<typeof resolveExecSafeBinRuntimePolicy>["trustedSafeBinDirs"];
  cwd: string | undefined;
  env: Record<string, string> | undefined;
  skillBins: SkillBinTrustEntry[];
  autoAllowSkills: boolean;
}): Promise<SystemRunAllowlistAnalysis> {
  if (params.shellCommand) {
    const allowlistEval = await evaluateShellAllowlist({
      command: params.shellCommand,
      allowlist: params.approvals.allowlist,
      safeBins: params.safeBins,
      safeBinProfiles: params.safeBinProfiles,
      cwd: params.cwd,
      env: params.env,
      trustedSafeBinDirs: params.trustedSafeBinDirs,
      skillBins: params.skillBins,
      autoAllowSkills: params.autoAllowSkills,
      platform: process.platform,
    });
    return {
      analysisOk: allowlistEval.analysisOk,
      allowlistMatches: allowlistEval.allowlistMatches,
      allowlistSatisfied:
        params.security === "allowlist" && allowlistEval.analysisOk
          ? allowlistEval.allowlistSatisfied
          : false,
      segments: allowlistEval.segments,
      segmentAllowlistEntries: allowlistEval.segmentAllowlistEntries,
      segmentPinnedArgvTokens: allowlistEval.segmentPinnedArgvTokens,
      segmentSatisfiedBy: allowlistEval.segmentSatisfiedBy,
      authorizationPlan: allowlistEval.authorizationPlan,
    };
  }

  const analysis = analyzeArgvCommand({ argv: params.argv, cwd: params.cwd, env: params.env });
  const allowlistEval = evaluateExecAllowlist({
    analysis,
    allowlist: params.approvals.allowlist,
    safeBins: params.safeBins,
    safeBinProfiles: params.safeBinProfiles,
    cwd: params.cwd,
    env: params.env,
    platform: process.platform,
    trustedSafeBinDirs: params.trustedSafeBinDirs,
    skillBins: params.skillBins,
    autoAllowSkills: params.autoAllowSkills,
  });
  return {
    analysisOk: analysis.ok,
    allowlistMatches: allowlistEval.allowlistMatches,
    allowlistSatisfied:
      params.security === "allowlist" && analysis.ok ? allowlistEval.allowlistSatisfied : false,
    segments: analysis.segments,
    segmentAllowlistEntries: allowlistEval.segmentAllowlistEntries,
    segmentPinnedArgvTokens: allowlistEval.segmentPinnedArgvTokens,
    segmentSatisfiedBy: allowlistEval.segmentSatisfiedBy,
  };
}

export function resolvePlannedAllowlistArgv(params: {
  security: ExecSecurity;
  shellCommand: string | null;
  policy: {
    approvedByAsk: boolean;
    analysisOk: boolean;
    allowlistSatisfied: boolean;
  };
  segments: ExecCommandSegment[];
}): string[] | undefined | null {
  if (
    params.security !== "allowlist" ||
    params.policy.approvedByAsk ||
    params.shellCommand ||
    !params.policy.analysisOk ||
    !params.policy.allowlistSatisfied ||
    params.segments.length !== 1
  ) {
    return undefined;
  }
  const plannedAllowlistArgv = resolvePlannedSegmentArgv(params.segments[0]);
  return plannedAllowlistArgv && plannedAllowlistArgv.length > 0 ? plannedAllowlistArgv : null;
}

export function resolveSystemRunExecArgv(params: {
  plannedAllowlistArgv: string[] | undefined;
  argv: string[];
  security: ExecSecurity;
  isWindows: boolean;
  policy: {
    approvedByAsk: boolean;
    analysisOk: boolean;
    allowlistSatisfied: boolean;
  };
  shellCommand: string | null;
  segments: ExecCommandSegment[];
  segmentPinnedArgvTokens: Array<ExecAllowlistPinnedArgvToken | null>;
  segmentSatisfiedBy: ExecSegmentSatisfiedBy[];
  authorizationPlan?: CommandAuthorizationPlan;
  cwd: string | undefined;
  env: Record<string, string> | undefined;
}): string[] | null {
  let execArgv = params.plannedAllowlistArgv ?? params.argv;
  if (
    params.security === "allowlist" &&
    !params.isWindows &&
    !params.policy.approvedByAsk &&
    !params.shellCommand &&
    params.policy.analysisOk &&
    params.policy.allowlistSatisfied
  ) {
    const pinnedExecArgv = applyPinnedArgvTokens({
      execArgv,
      sourceArgv: params.argv,
      pinnedArgvTokens: params.segmentPinnedArgvTokens,
    });
    if (!pinnedExecArgv) {
      return null;
    }
    execArgv = pinnedExecArgv;
  }
  if (
    params.security === "allowlist" &&
    params.isWindows &&
    !params.policy.approvedByAsk &&
    params.shellCommand &&
    params.policy.analysisOk &&
    params.policy.allowlistSatisfied &&
    params.segments.length === 1 &&
    params.segments[0]?.argv.length > 0
  ) {
    execArgv = params.segments[0].argv;
  }
  if (
    params.security === "allowlist" &&
    !params.isWindows &&
    !params.policy.approvedByAsk &&
    params.shellCommand &&
    params.policy.analysisOk &&
    params.policy.allowlistSatisfied &&
    params.segmentSatisfiedBy.some(
      (entry) => entry === "allowlist" || entry === "safeBins" || entry === "inlineChain",
    ) &&
    isPosixShellInlineCommandTransport(params.argv)
  ) {
    if (!params.authorizationPlan) {
      return null;
    }
    const rebuilt = renderAuthorizationShellCommand({
      plan: params.authorizationPlan,
      segments: params.segments,
      segmentPinnedArgvTokens: params.segmentPinnedArgvTokens,
      segmentSatisfiedBy: params.segmentSatisfiedBy,
      platform: process.platform,
      mode: "safe-bins",
    });
    if (!rebuilt.ok || !rebuilt.command) {
      return null;
    }
    const rewrittenArgv = replacePosixShellInlineCommand({
      argv: params.argv,
      oldCommand: params.shellCommand,
      nextCommand: rebuilt.command,
    });
    if (!rewrittenArgv) {
      return null;
    }
    execArgv = rewrittenArgv;
  }
  return execArgv;
}

function applyPinnedArgvTokens(params: {
  execArgv: string[];
  sourceArgv: readonly string[];
  pinnedArgvTokens: readonly (ExecAllowlistPinnedArgvToken | null)[];
}): string[] | null {
  let rewritten: string[] | null = null;
  for (const pinned of params.pinnedArgvTokens) {
    if (!pinned) {
      continue;
    }
    const tokenIndex = resolvePinnedArgvTokenExecIndex({
      execArgv: params.execArgv,
      sourceArgv: params.sourceArgv,
      pinned,
    });
    if (tokenIndex === null) {
      return null;
    }
    rewritten ??= [...params.execArgv];
    rewritten[tokenIndex] = pinned.replacement;
  }
  return rewritten ?? params.execArgv;
}

function resolvePinnedArgvTokenExecIndex(params: {
  execArgv: readonly string[];
  sourceArgv: readonly string[];
  pinned: ExecAllowlistPinnedArgvToken;
}): number | null {
  const sourceToken = params.sourceArgv[params.pinned.tokenIndex];
  if (sourceToken === undefined) {
    return null;
  }
  const directExecToken = params.execArgv[params.pinned.tokenIndex];
  if (directExecToken === sourceToken) {
    return params.pinned.tokenIndex;
  }

  const unwrappedOffset = params.sourceArgv.length - params.execArgv.length;
  const shiftedIndex = params.pinned.tokenIndex - unwrappedOffset;
  const shiftedExecToken = params.execArgv[shiftedIndex];
  if (shiftedExecToken === sourceToken) {
    return shiftedIndex;
  }
  return null;
}

function isPosixShellInlineCommandTransport(argv: string[]): boolean {
  const transportArgv = resolveShellWrapperTransportArgv(argv);
  return Boolean(
    transportArgv &&
    POSIX_SHELL_WRAPPER_NAMES.has(normalizeExecutableToken(transportArgv[0] ?? "")),
  );
}

function findSubsequence(haystack: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0 || needle.length > haystack.length) {
    return -1;
  }
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    let matches = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return start;
    }
  }
  return -1;
}

function replacePosixShellInlineCommand(params: {
  argv: string[];
  oldCommand: string;
  nextCommand: string;
}): string[] | null {
  const transportArgv = resolveShellWrapperTransportArgv(params.argv);
  if (
    !transportArgv ||
    !POSIX_SHELL_WRAPPER_NAMES.has(normalizeExecutableToken(transportArgv[0] ?? ""))
  ) {
    return null;
  }
  const transportStart = findSubsequence(params.argv, transportArgv);
  if (transportStart < 0) {
    return null;
  }
  const match = resolveInlineCommandMatch(transportArgv, POSIX_INLINE_COMMAND_FLAGS, {
    allowCombinedC: true,
  });
  if (match.valueTokenIndex === null) {
    return null;
  }
  const absoluteValueIndex = transportStart + match.valueTokenIndex;
  const token = params.argv[absoluteValueIndex];
  if (token === undefined) {
    return null;
  }
  const rewritten = [...params.argv];
  if (token === params.oldCommand) {
    rewritten[absoluteValueIndex] = params.nextCommand;
    return rewritten;
  }
  if (token.endsWith(params.oldCommand)) {
    rewritten[absoluteValueIndex] =
      token.slice(0, token.length - params.oldCommand.length) + params.nextCommand;
    return rewritten;
  }
  return null;
}

export function applyOutputTruncation(result: RunResult): void {
  if (!result.truncated) {
    return;
  }
  const suffix = "... (truncated)";
  if (result.stderr.trim().length > 0) {
    result.stderr = `${result.stderr}\n${suffix}`;
  } else {
    result.stdout = `${result.stdout}\n${suffix}`;
  }
}
