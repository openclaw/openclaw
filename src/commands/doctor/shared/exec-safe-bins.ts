import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { sanitizeForLog } from "../../../../packages/terminal-core/src/ansi.js";
import { listAgentEntriesWithSource } from "../../../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveCommandResolutionFromArgv } from "../../../infra/exec-command-resolution.js";
import {
  normalizeConfiguredSafeBins,
  normalizeConfiguredTrustedSafeBinDirs,
} from "../../../infra/exec-safe-bin-config.js";
import {
  listInterpreterLikeSafeBins,
  resolveMergedSafeBinProfileFixtures,
} from "../../../infra/exec-safe-bin-runtime-policy.js";
import {
  listRiskyConfiguredSafeBins,
  normalizeSafeBinName,
} from "../../../infra/exec-safe-bin-semantics.js";
import { getTrustedSafeBinDirs, isTrustedSafeBinPath } from "../../../infra/exec-safe-bin-trust.js";

type ExecSafeBinCoverageHit = {
  /** Config scope that owns the safeBins entry. */
  scopePath: string;
  /** Normalized binary name from safeBins. */
  bin: string;
  kind: "missingProfile" | "riskySemantics";
  isInterpreter?: boolean;
  warning?: string;
};

type ExecSafeBinScopeRef = {
  scopePath: string;
  safeBins: string[];
  exec: Record<string, unknown>;
  mergedProfiles: Record<string, unknown>;
  trustedSafeBinDirs: ReadonlySet<string>;
};

type ExecSafeBinTrustedDirHintHit = {
  /** Config scope that owns the safeBins entry. */
  scopePath: string;
  /** Binary name configured in safeBins. */
  bin: string;
  /** Resolved executable path outside trusted safe-bin directories. */
  resolvedPath: string;
};

function collectExecSafeBinScopes(cfg: OpenClawConfig): ExecSafeBinScopeRef[] {
  const scopes: ExecSafeBinScopeRef[] = [];
  const globalExec = asNullableRecord(cfg.tools?.exec);
  const globalTrustedDirs = normalizeConfiguredTrustedSafeBinDirs(globalExec?.safeBinTrustedDirs);
  const candidates = [
    { exec: globalExec, scopePath: "tools.exec", local: undefined },
    ...listAgentEntriesWithSource(cfg).map(({ entry: agent, source }) => {
      const exec = asNullableRecord(agent.tools?.exec);
      return {
        exec,
        local: exec,
        scopePath:
          source.kind === "entries"
            ? `agents.entries.${source.key}.tools.exec`
            : `agents.list.${source.index}.tools.exec`,
      };
    }),
  ];
  for (const { exec, scopePath, local } of candidates) {
    if (!exec) {
      continue;
    }
    const safeBins = normalizeConfiguredSafeBins(exec.safeBins);
    if (safeBins.length === 0) {
      continue;
    }
    scopes.push({
      scopePath,
      safeBins,
      exec,
      mergedProfiles: resolveMergedSafeBinProfileFixtures({ global: globalExec, local }) ?? {},
      trustedSafeBinDirs: getTrustedSafeBinDirs({
        extraDirs: [
          ...globalTrustedDirs,
          ...normalizeConfiguredTrustedSafeBinDirs(local?.safeBinTrustedDirs),
        ],
      }),
    });
  }
  return scopes;
}

function inspectSafeBinProfiles(scope: ExecSafeBinScopeRef) {
  const interpreterBins = new Set(listInterpreterLikeSafeBins(scope.safeBins));
  const riskyHits = listRiskyConfiguredSafeBins(scope.safeBins);
  const riskyBins = new Set(riskyHits.map((hit) => hit.bin));
  const missingBins = scope.safeBins.filter(
    (bin) => !scope.mergedProfiles[bin] && !riskyBins.has(normalizeSafeBinName(bin)),
  );
  return { interpreterBins, riskyHits, missingBins };
}

export function scanExecSafeBinCoverage(cfg: OpenClawConfig): ExecSafeBinCoverageHit[] {
  const hits: ExecSafeBinCoverageHit[] = [];
  for (const scope of collectExecSafeBinScopes(cfg)) {
    const { interpreterBins, riskyHits, missingBins } = inspectSafeBinProfiles(scope);
    for (const bin of missingBins) {
      hits.push({
        scopePath: scope.scopePath,
        bin,
        kind: "missingProfile",
        isInterpreter: interpreterBins.has(bin),
      });
    }
    for (const hit of riskyHits) {
      hits.push({
        scopePath: scope.scopePath,
        bin: hit.bin,
        kind: "riskySemantics",
        warning: hit.warning,
      });
    }
  }
  return hits;
}

export function scanExecSafeBinTrustedDirHints(
  cfg: OpenClawConfig,
): ExecSafeBinTrustedDirHintHit[] {
  const hits: ExecSafeBinTrustedDirHintHit[] = [];
  for (const scope of collectExecSafeBinScopes(cfg)) {
    for (const bin of scope.safeBins) {
      const resolution = resolveCommandResolutionFromArgv([bin]);
      if (!resolution?.execution.resolvedPath) {
        continue;
      }
      if (
        isTrustedSafeBinPath({
          resolvedPath: resolution.execution.resolvedPath,
          trustedDirs: scope.trustedSafeBinDirs,
        })
      ) {
        continue;
      }
      hits.push({
        scopePath: scope.scopePath,
        bin,
        resolvedPath: resolution.execution.resolvedPath,
      });
    }
  }
  return hits;
}

function collectLimitedWarnings<T>(
  hits: T[],
  format: (hit: T) => string,
  remainder: string,
): string[] {
  const lines = hits.slice(0, 5).map(format);
  if (hits.length > 5) {
    lines.push(`- ${hits.length - 5} more ${remainder}`);
  }
  return lines;
}

export function collectExecSafeBinCoverageWarnings(params: {
  hits: ExecSafeBinCoverageHit[];
  doctorFixCommand: string;
}): string[] {
  const interpreterHits = params.hits.filter(
    (hit) => hit.kind === "missingProfile" && hit.isInterpreter,
  );
  const customHits = params.hits.filter(
    (hit) => hit.kind === "missingProfile" && !hit.isInterpreter,
  );
  const riskyHits = params.hits.filter((hit) => hit.kind === "riskySemantics");
  const lines = [
    ...collectLimitedWarnings(
      interpreterHits,
      (hit) =>
        `- ${sanitizeForLog(hit.scopePath)}.safeBins includes interpreter/runtime '${sanitizeForLog(hit.bin)}' without profile.`,
      "interpreter/runtime safeBins entries are missing profiles.",
    ),
    ...collectLimitedWarnings(
      customHits,
      (hit) =>
        `- ${sanitizeForLog(hit.scopePath)}.safeBins entry '${sanitizeForLog(hit.bin)}' is missing safeBinProfiles.${sanitizeForLog(hit.bin)}.`,
      "custom safeBins entries are missing profiles.",
    ),
    ...collectLimitedWarnings(
      riskyHits,
      (hit) =>
        `- ${sanitizeForLog(hit.scopePath)}.safeBins includes '${sanitizeForLog(hit.bin)}': ${sanitizeForLog(hit.warning ?? "prefer explicit allowlist entries or approval-gated runs.")}`,
      "safeBins entries should not use the low-risk safeBins fast path.",
    ),
  ];
  if (customHits.length > 0) {
    lines.push(
      `- Run "${params.doctorFixCommand}" to scaffold missing custom safeBinProfiles entries.`,
    );
  }
  return lines;
}

export function collectExecSafeBinTrustedDirHintWarnings(
  hits: ExecSafeBinTrustedDirHintHit[],
): string[] {
  if (hits.length === 0) {
    return [];
  }
  const lines = collectLimitedWarnings(
    hits,
    (hit) =>
      `- ${sanitizeForLog(hit.scopePath)}.safeBins entry '${sanitizeForLog(hit.bin)}' resolves to '${sanitizeForLog(hit.resolvedPath)}' outside trusted safe-bin dirs.`,
    "safeBins entries resolve outside trusted safe-bin dirs.",
  );
  lines.push(
    "- If intentional, add the binary directory to tools.exec.safeBinTrustedDirs (global or agent scope).",
  );
  return lines;
}

export function maybeRepairExecSafeBinProfiles(cfg: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
  warnings: string[];
} {
  const next = structuredClone(cfg);
  const changes: string[] = [];
  const warnings: string[] = [];

  for (const scope of collectExecSafeBinScopes(next)) {
    const { interpreterBins, riskyHits, missingBins } = inspectSafeBinProfiles(scope);
    for (const hit of riskyHits) {
      warnings.push(`- ${scope.scopePath}.safeBins includes '${hit.bin}': ${hit.warning}`);
    }
    if (missingBins.length === 0) {
      continue;
    }
    const profileHolder =
      asNullableRecord(scope.exec.safeBinProfiles) ?? (scope.exec.safeBinProfiles = {});
    for (const bin of missingBins) {
      if (interpreterBins.has(bin)) {
        warnings.push(
          `- ${scope.scopePath}.safeBins includes interpreter/runtime '${bin}' without profile; remove it from safeBins or use explicit allowlist entries.`,
        );
        continue;
      }
      if (profileHolder[bin] !== undefined) {
        continue;
      }
      profileHolder[bin] = {};
      changes.push(
        `- ${scope.scopePath}.safeBinProfiles.${bin}: added scaffold profile {} (review and tighten flags/positionals).`,
      );
    }
  }

  return { config: changes.length > 0 || warnings.length > 0 ? next : cfg, changes, warnings };
}
