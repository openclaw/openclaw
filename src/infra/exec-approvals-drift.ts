import type {
  ExecAllowlistEntry,
  ExecApprovalsAgent,
  ExecApprovalsFile,
} from "./exec-approvals.js";
import { normalizeExecutableToken } from "./exec-wrapper-resolution.js";

export type ExecApprovalDriftWrapperCoverage = {
  ocBuilderRunCount: number;
  ocHostDiagCount: number;
  ocSafeGitCount: number;
};

export type ExecApprovalDriftCounts = {
  totalAllowlistEntries: number;
  allowAlwaysCount: number;
  nonAllowAlwaysCount: number;
  opaqueCommandPatternCount: number;
  bogusEnvironmentLikePatternCount: number;
  rawUtilityPatternCount: number;
  interpreterPatternCount: number;
  wrapperCoverage: ExecApprovalDriftWrapperCoverage;
};

export type ExecApprovalDriftAgentSummary = ExecApprovalDriftCounts & {
  agentId: string;
};

export type ExecApprovalDriftStats = ExecApprovalDriftCounts & {
  agentSummaries: ExecApprovalDriftAgentSummary[];
};

const INTERPRETER_PATTERN_NAMES = new Set([
  "python",
  "python2",
  "python3",
  "pypy",
  "pypy3",
  "node",
  "nodejs",
  "bun",
  "deno",
  "ruby",
  "perl",
  "php",
  "lua",
  "osascript",
  "find",
]);

function createEmptyWrapperCoverage(): ExecApprovalDriftWrapperCoverage {
  return {
    ocBuilderRunCount: 0,
    ocHostDiagCount: 0,
    ocSafeGitCount: 0,
  };
}

function createEmptyCounts(): ExecApprovalDriftCounts {
  return {
    totalAllowlistEntries: 0,
    allowAlwaysCount: 0,
    nonAllowAlwaysCount: 0,
    opaqueCommandPatternCount: 0,
    bogusEnvironmentLikePatternCount: 0,
    rawUtilityPatternCount: 0,
    interpreterPatternCount: 0,
    wrapperCoverage: createEmptyWrapperCoverage(),
  };
}

function mergeCounts(
  target: ExecApprovalDriftCounts,
  source: ExecApprovalDriftCounts,
): ExecApprovalDriftCounts {
  target.totalAllowlistEntries += source.totalAllowlistEntries;
  target.allowAlwaysCount += source.allowAlwaysCount;
  target.nonAllowAlwaysCount += source.nonAllowAlwaysCount;
  target.opaqueCommandPatternCount += source.opaqueCommandPatternCount;
  target.bogusEnvironmentLikePatternCount += source.bogusEnvironmentLikePatternCount;
  target.rawUtilityPatternCount += source.rawUtilityPatternCount;
  target.interpreterPatternCount += source.interpreterPatternCount;
  target.wrapperCoverage.ocBuilderRunCount += source.wrapperCoverage.ocBuilderRunCount;
  target.wrapperCoverage.ocHostDiagCount += source.wrapperCoverage.ocHostDiagCount;
  target.wrapperCoverage.ocSafeGitCount += source.wrapperCoverage.ocSafeGitCount;
  return target;
}

function isOpaqueCommandPattern(pattern: string): boolean {
  return pattern.length > 0 && /^=command:/iu.test(pattern);
}

function isBogusEnvironmentLikePattern(pattern: string): boolean {
  // Drift can persist malformed env-assignment-looking tokens such as `/PATH=...`
  // that are not executable paths and should be surfaced separately.
  return /^\/[A-Za-z_][A-Za-z0-9_]*=.*/u.test(pattern);
}

function resolvePatternExecutableName(pattern: string): string | null {
  if (!pattern || pattern === "*" || isOpaqueCommandPattern(pattern)) {
    return null;
  }
  return normalizeExecutableToken(pattern);
}

function recordWrapperCoverage(
  counts: ExecApprovalDriftCounts,
  executableName: string | null,
): boolean {
  if (executableName === "oc-builder-run") {
    counts.wrapperCoverage.ocBuilderRunCount += 1;
    return true;
  }
  if (executableName === "oc-host-diag") {
    counts.wrapperCoverage.ocHostDiagCount += 1;
    return true;
  }
  if (executableName === "oc-safe-git") {
    counts.wrapperCoverage.ocSafeGitCount += 1;
    return true;
  }
  return false;
}

function collectAllowlistCounts(
  allowlist: readonly ExecAllowlistEntry[] | undefined,
): ExecApprovalDriftCounts {
  const counts = createEmptyCounts();
  for (const entry of allowlist ?? []) {
    counts.totalAllowlistEntries += 1;
    if (entry.source === "allow-always") {
      counts.allowAlwaysCount += 1;
    } else {
      counts.nonAllowAlwaysCount += 1;
    }

    const pattern = entry.pattern.trim();
    if (!pattern) {
      continue;
    }

    const opaqueCommandPattern = isOpaqueCommandPattern(pattern);
    if (opaqueCommandPattern) {
      counts.opaqueCommandPatternCount += 1;
    }

    const bogusEnvironmentLikePattern = isBogusEnvironmentLikePattern(pattern);
    if (bogusEnvironmentLikePattern) {
      counts.bogusEnvironmentLikePatternCount += 1;
    }

    const executableName = resolvePatternExecutableName(pattern);
    const wrapperCovered = recordWrapperCoverage(counts, executableName);
    const interpreterPattern = Boolean(
      executableName && INTERPRETER_PATTERN_NAMES.has(executableName),
    );
    if (interpreterPattern) {
      counts.interpreterPatternCount += 1;
    }

    if (
      executableName &&
      !wrapperCovered &&
      !interpreterPattern &&
      !opaqueCommandPattern &&
      !bogusEnvironmentLikePattern
    ) {
      counts.rawUtilityPatternCount += 1;
    }
  }
  return counts;
}

function buildAgentSummary(
  agentId: string,
  agent: ExecApprovalsAgent,
): ExecApprovalDriftAgentSummary {
  return {
    agentId,
    ...collectAllowlistCounts(agent.allowlist),
  };
}

export function collectExecApprovalDriftStats(file: ExecApprovalsFile): ExecApprovalDriftStats {
  const agentSummaries = Object.entries(file.agents ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([agentId, agent]) => buildAgentSummary(agentId, agent));

  const totals = agentSummaries.reduce(mergeCounts, createEmptyCounts());
  return {
    ...totals,
    agentSummaries,
  };
}
