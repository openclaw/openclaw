// Doctor checks and repairs for exec safeBins profiles and trusted binary directories.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../../../packages/terminal-core/src/ansi.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveCommandResolutionFromArgv } from "../../../infra/exec-command-resolution.js";
import {
  isBuiltinSafeBinProfile,
  normalizeSafeBinProfileFixtures,
  type SafeBinProfileFixture,
} from "../../../infra/exec-safe-bin-policy.js";
import {
  listInterpreterLikeSafeBins,
  resolveMergedSafeBinProfileFixtures,
} from "../../../infra/exec-safe-bin-runtime-policy.js";
import { listRiskyConfiguredSafeBins } from "../../../infra/exec-safe-bin-semantics.js";
import {
  getTrustedSafeBinDirs,
  isTrustedSafeBinPath,
  normalizeTrustedSafeBinDirs,
} from "../../../infra/exec-safe-bin-trust.js";
import { asObjectRecord } from "./object.js";

export type ExecSafeBinCoverageHit = {
  /** Config scope that owns the safeBins entry. */
  scopePath: string;
  /** Normalized binary name from safeBins. */
  bin: string;
  /**
   * Coverage classification:
   * - `missingProfile`: a custom or interpreter bin in safeBins with no profile.
   * - `builtinProfile`: a built-in bin relying on its shipped profile (info only, no scaffold).
   * - `emptyBuiltinOverride`: an explicit empty `{}` override that wipes a built-in profile.
   * - `riskySemantics`: a bin whose semantics are too broad for the safeBins fast path.
   */
  kind: "missingProfile" | "builtinProfile" | "emptyBuiltinOverride" | "riskySemantics";
  /** True when the missing profile belongs to an interpreter/runtime binary. */
  isInterpreter?: boolean;
  /** Risk explanation for risky semantic hits. */
  warning?: string;
};

type ExecSafeBinScopeRef = {
  scopePath: string;
  safeBins: string[];
  exec: Record<string, unknown>;
  mergedProfiles: Record<string, SafeBinProfileFixture>;
  trustedSafeBinDirs: ReadonlySet<string>;
};

/** A normalized fixture carries no constraints when every positional limit and flag set is empty. */
function isEmptySafeBinProfileFixture(fixture: SafeBinProfileFixture): boolean {
  return (
    fixture.minPositional === undefined &&
    fixture.maxPositional === undefined &&
    (fixture.allowedValueFlags?.length ?? 0) === 0 &&
    (fixture.deniedFlags?.length ?? 0) === 0
  );
}

/** True when a raw user safeBinProfiles value normalizes to a no-op (empty) override. */
function isEmptyRawSafeBinProfile(value: unknown): boolean {
  // Reuse the runtime normalizer so empty flag arrays collapse to undefined exactly as at runtime.
  const normalized = normalizeSafeBinProfileFixtures({
    probe: value as SafeBinProfileFixture,
  }).probe;
  return normalized === undefined || isEmptySafeBinProfileFixture(normalized);
}

/** Lists built-in bins whose explicit override is an empty `{}` that wipes the shipped profile. */
function listEmptyBuiltinOverrides(exec: Record<string, unknown>): string[] {
  const ownProfiles = asObjectRecord(exec.safeBinProfiles);
  if (!ownProfiles) {
    return [];
  }
  return Object.keys(ownProfiles)
    .toSorted()
    .filter((bin) => isBuiltinSafeBinProfile(bin) && isEmptyRawSafeBinProfile(ownProfiles[bin]));
}

export type ExecSafeBinTrustedDirHintHit = {
  /** Config scope that owns the safeBins entry. */
  scopePath: string;
  /** Binary name configured in safeBins. */
  bin: string;
  /** Resolved executable path outside trusted safe-bin directories. */
  resolvedPath: string;
};

function normalizeConfiguredSafeBins(entries: unknown): string[] {
  if (!Array.isArray(entries)) {
    return [];
  }
  return Array.from(
    new Set(
      entries
        .map((entry) => normalizeOptionalLowercaseString(entry) ?? "")
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

/**
 * Lists every config scope that carries a `safeBinProfiles` object, regardless of `safeBins`.
 * Empty `{}` overrides of built-in bins must be found here, not via the safeBins-gated scopes:
 * a global override reaches agents through profile inheritance, and an agent override applies even
 * when the agent inherits the global `safeBins` list (resolveExecSafeBinRuntimePolicy falls back to
 * global safeBins). Either way the empty override silently disables the built-in profile at runtime.
 */
function collectSafeBinProfileScopes(
  cfg: OpenClawConfig,
): Array<{ scopePath: string; exec: Record<string, unknown> }> {
  const scopes: Array<{ scopePath: string; exec: Record<string, unknown> }> = [];
  const globalExec = asObjectRecord(cfg.tools?.exec);
  if (globalExec && asObjectRecord(globalExec.safeBinProfiles)) {
    scopes.push({ scopePath: "tools.exec", exec: globalExec });
  }
  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  for (const agent of agents) {
    if (!agent || typeof agent !== "object" || typeof agent.id !== "string") {
      continue;
    }
    const agentExec = asObjectRecord(agent.tools?.exec);
    if (agentExec && asObjectRecord(agentExec.safeBinProfiles)) {
      scopes.push({ scopePath: `agents.list.${agent.id}.tools.exec`, exec: agentExec });
    }
  }
  return scopes;
}

/** Scan configured safeBins for missing profiles and risky low-friction entries. */
export function scanExecSafeBinCoverage(cfg: OpenClawConfig): ExecSafeBinCoverageHit[] {
  const hits: ExecSafeBinCoverageHit[] = [];
  for (const scope of collectExecSafeBinScopes(cfg)) {
    const interpreterBins = new Set(listInterpreterLikeSafeBins(scope.safeBins));
    for (const bin of scope.safeBins) {
      if (scope.mergedProfiles[bin]) {
        // Has a user profile (covered); empty overrides are flagged from safeBinProfiles below.
        continue;
      }
      if (interpreterBins.has(bin)) {
        hits.push({ scopePath: scope.scopePath, bin, kind: "missingProfile", isInterpreter: true });
        continue;
      }
      if (isBuiltinSafeBinProfile(bin)) {
        // Built-in profile is already active at runtime, so this is informational, never scaffolded.
        hits.push({ scopePath: scope.scopePath, bin, kind: "builtinProfile" });
        continue;
      }
      hits.push({ scopePath: scope.scopePath, bin, kind: "missingProfile", isInterpreter: false });
    }
    for (const hit of listRiskyConfiguredSafeBins(scope.safeBins)) {
      hits.push({
        scopePath: scope.scopePath,
        bin: hit.bin,
        kind: "riskySemantics",
        warning: hit.warning,
      });
    }
  }
  // Empty built-in overrides are scanned across all profile scopes, not the safeBins-gated ones,
  // so inherited/fallback overrides that disable a built-in at runtime are still surfaced.
  for (const { scopePath, exec } of collectSafeBinProfileScopes(cfg)) {
    for (const bin of listEmptyBuiltinOverrides(exec)) {
      hits.push({ scopePath, bin, kind: "emptyBuiltinOverride" });
    }
  }
  return hits;
}

/** Scan configured safeBins that resolve outside trusted binary directories. */
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

/** Format doctor warnings for safeBins profile coverage and risky semantics. */
export function collectExecSafeBinCoverageWarnings(params: {
  hits: ExecSafeBinCoverageHit[];
  doctorFixCommand: string;
}): string[] {
  if (params.hits.length === 0) {
    return [];
  }
  const interpreterHits = params.hits.filter(
    (hit) => hit.kind === "missingProfile" && hit.isInterpreter,
  );
  const customHits = params.hits.filter(
    (hit) => hit.kind === "missingProfile" && !hit.isInterpreter,
  );
  const emptyOverrideHits = params.hits.filter((hit) => hit.kind === "emptyBuiltinOverride");
  const riskyHits = params.hits.filter((hit) => hit.kind === "riskySemantics");
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
  if (emptyOverrideHits.length > 0) {
    for (const hit of emptyOverrideHits.slice(0, 5)) {
      lines.push(
        `- ${sanitizeForLog(hit.scopePath)}.safeBinProfiles.${sanitizeForLog(hit.bin)}: empty profile overrides built-in defaults (positional limits, allowedValueFlags, and deniedFlags are lost). Remove this entry to restore built-in protection, or provide explicit constraints.`,
      );
    }
    if (emptyOverrideHits.length > 5) {
      lines.push(
        `- ${emptyOverrideHits.length - 5} more safeBinProfiles entries override built-in defaults with empty profiles.`,
      );
    }
  }
  if (riskyHits.length > 0) {
    for (const hit of riskyHits.slice(0, 5)) {
      lines.push(
        `- ${sanitizeForLog(hit.scopePath)}.safeBins includes '${sanitizeForLog(hit.bin)}': ${sanitizeForLog(hit.warning ?? "prefer explicit allowlist entries or approval-gated runs.")}`,
      );
    }
    if (riskyHits.length > 5) {
      lines.push(
        `- ${riskyHits.length - 5} more safeBins entries should not use the low-risk safeBins fast path.`,
      );
    }
  }
  // Only suggest --fix scaffolding when there are custom bins to scaffold; built-in bins are not.
  if (customHits.length > 0) {
    lines.push(
      `- Run "${params.doctorFixCommand}" to scaffold missing custom safeBinProfiles entries.`,
    );
  }
  return lines;
}

/** Format informational doctor notes for safeBins that rely on their shipped built-in profile. */
export function collectExecSafeBinCoverageInfoNotes(params: {
  hits: ExecSafeBinCoverageHit[];
}): string[] {
  const builtinHits = params.hits.filter((hit) => hit.kind === "builtinProfile");
  if (builtinHits.length === 0) {
    return [];
  }
  const lines = builtinHits
    .slice(0, 5)
    .map(
      (hit) =>
        `- ${sanitizeForLog(hit.scopePath)}.safeBins entry '${sanitizeForLog(hit.bin)}' uses built-in profile (no custom override needed).`,
    );
  if (builtinHits.length > 5) {
    lines.push(`- ${builtinHits.length - 5} more safeBins entries use built-in profiles.`);
  }
  return lines;
}

/** Format doctor warnings for safeBins resolved outside trusted directories. */
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

/** Scaffold missing custom safeBin profiles and warn on interpreter/risky entries. */
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
    for (const hit of listRiskyConfiguredSafeBins(scope.safeBins)) {
      warnings.push(`- ${scope.scopePath}.safeBins includes '${hit.bin}': ${hit.warning}`);
    }
    // Scaffold a stdin-only default only for custom bins. Built-in profiles are already active at
    // runtime (scaffolding them would clobber the shipped constraints), and interpreters are too
    // broad to constrain via a profile. Create the profiles holder lazily so we never leave an
    // empty `{}` safeBinProfiles object behind when nothing is scaffolded.
    for (const bin of scope.safeBins) {
      if (scope.mergedProfiles[bin]) {
        continue;
      }
      if (interpreterBins.has(bin)) {
        warnings.push(
          `- ${scope.scopePath}.safeBins includes interpreter/runtime '${bin}' without profile; remove it from safeBins or use explicit allowlist entries.`,
        );
        continue;
      }
      if (isBuiltinSafeBinProfile(bin)) {
        continue;
      }
      const profileHolder =
        asObjectRecord(scope.exec.safeBinProfiles) ?? (scope.exec.safeBinProfiles = {});
      if (profileHolder[bin] !== undefined) {
        continue;
      }
      profileHolder[bin] = { maxPositional: 0 };
      changes.push(
        `- ${scope.scopePath}.safeBinProfiles.${bin}: added scaffold profile { maxPositional: 0 } (stdin-only default; review and adjust flags/positionals).`,
      );
    }
  }

  // Remove empty `{}` overrides of built-in bins across all profile scopes (including inherited and
  // safeBins-fallback cases): they silently wipe the shipped profile via the key-spread in
  // resolveSafeBinProfiles, so deleting them restores built-in protection.
  for (const { scopePath, exec } of collectSafeBinProfileScopes(next)) {
    const profileHolder = asObjectRecord(exec.safeBinProfiles);
    if (!profileHolder) {
      continue;
    }
    for (const bin of listEmptyBuiltinOverrides(exec)) {
      delete profileHolder[bin];
      changes.push(
        `- ${scopePath}.safeBinProfiles.${bin}: removed empty override that disabled the built-in profile (restored built-in positional limits, allowedValueFlags, and deniedFlags).`,
      );
    }
    if (Object.keys(profileHolder).length === 0) {
      delete exec.safeBinProfiles;
    }
  }

  if (changes.length === 0 && warnings.length === 0) {
    return { config: cfg, changes: [], warnings: [] };
  }
  return { config: next, changes, warnings };
}
