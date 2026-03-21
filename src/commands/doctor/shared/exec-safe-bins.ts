import type { OpenClawConfig } from "../../../config/config.js";
import { resolveCommandResolutionFromArgv } from "../../../infra/exec-command-resolution.js";
import {
  listInterpreterLikeSafeBins,
  resolveMergedSafeBinProfileFixtures,
} from "../../../infra/exec-safe-bin-runtime-policy.js";
import {
  getTrustedSafeBinDirs,
  isTrustedSafeBinPath,
  normalizeTrustedSafeBinDirs,
} from "../../../infra/exec-safe-bin-trust.js";
import { sanitizeForLog } from "../../../terminal/ansi.js";
import { asObjectRecord } from "./object.js";

export type ExecSafeBinCoverageHit = {
  scopePath: string;
  bin: string;
  isInterpreter: boolean;
};

type ExecSafeBinScopeRef = {
  scopePath: string;
  safeBins: string[];
  exec: Record<string, unknown>;
  mergedProfiles: Record<string, unknown>;
  trustedSafeBinDirs: ReadonlySet<string>;
};

export type ExecSafeBinTrustedDirHintHit = {
  scopePath: string;
  bin: string;
  resolvedPath: string;
};

function normalizeConfiguredSafeBins(entries: unknown): string[] {
  if (!Array.isArray(entries)) {
    return [];
  }
  return Array.from(
    new Set(
      entries
        .map((entry) => (typeof entry === "string" ? entry.trim().toLowerCase() : ""))
        .filter((entry) => entry.length > 0),
    ),
  ).toSorted();
}

function normalizeConfiguredTrustedSafeBinDirs(entries: unknown): string[] {
  if (!Array.isArray(entries)) {
    return [];
  }
  return normalizeTrustedSafeBinDirs(
    entries.filter((entry): entry is string => typeof entry === "string"),
  );
}

function collectExecSafeBinScopes(cfg: OpenClawConfig): ExecSafeBinScopeRef[] {
  const scopes: ExecSafeBinScopeRef[] = [];
  const globalExec = asObjectRecord(cfg.tools?.exec);
  const globalTrustedDirs = normalizeConfiguredTrustedSafeBinDirs(globalExec?.safeBinTrustedDirs);
  if (globalExec) {
    const safeBins = normalizeConfiguredSafeBins(globalExec.safeBins);
    if (safeBins.length > 0) {
      scopes.push({
        scopePath: "tools.exec",
        safeBins,
        exec: globalExec,
        mergedProfiles:
          resolveMergedSafeBinProfileFixtures({
            global: globalExec,
          }) ?? {},
        trustedSafeBinDirs: getTrustedSafeBinDirs({
          extraDirs: globalTrustedDirs,
        }),
      });
    }
  }
  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  for (const agent of agents) {
    if (!agent || typeof agent !== "object" || typeof agent.id !== "string") {
      continue;
    }
    const agentExec = asObjectRecord(agent.tools?.exec);
    if (!agentExec) {
      continue;
    }
    const safeBins = normalizeConfiguredSafeBins(agentExec.safeBins);
    if (safeBins.length === 0) {
      continue;
    }
    scopes.push({
      scopePath: `agents.list.${agent.id}.tools.exec`,
      safeBins,
      exec: agentExec,
      mergedProfiles:
        resolveMergedSafeBinProfileFixtures({
          global: globalExec,
          local: agentExec,
        }) ?? {},
      trustedSafeBinDirs: getTrustedSafeBinDirs({
        extraDirs: [
          ...globalTrustedDirs,
          ...normalizeConfiguredTrustedSafeBinDirs(agentExec.safeBinTrustedDirs),
        ],
      }),
    });
  }
  return scopes;
}

export function scanExecSafeBinCoverage(cfg: OpenClawConfig): ExecSafeBinCoverageHit[] {
  const hits: ExecSafeBinCoverageHit[] = [];
  for (const scope of collectExecSafeBinScopes(cfg)) {
    const interpreterBins = new Set(listInterpreterLikeSafeBins(scope.safeBins));
    for (const bin of scope.safeBins) {
      if (scope.mergedProfiles[bin]) {
        continue;
      }
      hits.push({
        scopePath: scope.scopePath,
        bin,
        isInterpreter: interpreterBins.has(bin),
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
      if (!resolution?.resolvedPath) {
        continue;
      }
      if (
        isTrustedSafeBinPath({
          resolvedPath: resolution.resolvedPath,
          trustedDirs: scope.trustedSafeBinDirs,
        })
      ) {
        continue;
      }
      hits.push({
        scopePath: scope.scopePath,
        bin,
        resolvedPath: resolution.resolvedPath,
      });
    }
  }
  return hits;
}

export function collectExecSafeBinCoverageWarnings(params: {
  hits: ExecSafeBinCoverageHit[];
  doctorFixCommand: string;
}): string[] {
  if (params.hits.length === 0) {
    return [];
  }
  const interpreterHits = params.hits.filter((hit) => hit.isInterpreter);
  const customHits = params.hits.filter((hit) => !hit.isInterpreter);
  const lines: string[] = [];
  if (interpreterHits.length > 0) {
    for (const hit of interpreterHits.slice(0, 5)) {
      lines.push(
        `- ${sanitizeForLog(hit.scopePath)}.safeBins includes interpreter/runtime '${sanitizeForLog(hit.bin)}' without profile.`,
      );
    }
    if (interpreterHits.length > 5) {
      lines.push(
        `- ${interpreterHits.length - 5} more interpreter/runtime safeBins entries are missing profiles.`,
      );
    }
  }
  if (customHits.length > 0) {
    for (const hit of customHits.slice(0, 5)) {
      lines.push(
        `- ${sanitizeForLog(hit.scopePath)}.safeBins entry '${sanitizeForLog(hit.bin)}' is missing safeBinProfiles.${sanitizeForLog(hit.bin)}.`,
      );
    }
    if (customHits.length > 5) {
      lines.push(`- ${customHits.length - 5} more custom safeBins entries are missing profiles.`);
    }
  }
  lines.push(
    `- Run "${params.doctorFixCommand}" to scaffold missing custom safeBinProfiles entries.`,
  );
  return lines;
}

export function collectExecSafeBinTrustedDirHintWarnings(
  hits: ExecSafeBinTrustedDirHintHit[],
): string[] {
  if (hits.length === 0) {
    return [];
  }
  const lines = hits
    .slice(0, 5)
    .map(
      (hit) =>
        `- ${sanitizeForLog(hit.scopePath)}.safeBins entry '${sanitizeForLog(hit.bin)}' resolves to '${sanitizeForLog(hit.resolvedPath)}' outside trusted safe-bin dirs.`,
    );
  if (hits.length > 5) {
    lines.push(`- ${hits.length - 5} more safeBins entries resolve outside trusted safe-bin dirs.`);
  }
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
    const interpreterBins = new Set(listInterpreterLikeSafeBins(scope.safeBins));
    const missingBins = scope.safeBins.filter((bin) => !scope.mergedProfiles[bin]);
    if (missingBins.length === 0) {
      continue;
    }
    const profileHolder =
      asObjectRecord(scope.exec.safeBinProfiles) ?? (scope.exec.safeBinProfiles = {});
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

  if (changes.length === 0 && warnings.length === 0) {
    return { config: cfg, changes: [], warnings: [] };
  }
  return { config: next, changes, warnings };
}
