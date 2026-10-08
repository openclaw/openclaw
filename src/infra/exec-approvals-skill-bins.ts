// Skill-bin trust for exec allowlist evaluation: autoAllowSkills trusts an executable only when
// a skill declares its bare name and it resolves to the same path the skill's bin resolved to.
import path from "node:path";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  resolveExecutionTargetResolution,
  resolveExecutionTargetTrustPath,
  type ExecCommandSegment,
} from "./exec-approvals-analysis.js";

export type SkillBinTrustEntry = {
  name: string;
  resolvedPath: string;
};

function isPathScopedExecutableToken(token: string): boolean {
  return token.includes("/") || token.includes("\\");
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

export function buildSkillBinTrustIndex(
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

export function isSkillAutoAllowedSegment(params: {
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

/**
 * Whether a segment's resolved executable is trusted by these skill bins, using the same
 * identity comparison the allowlist evaluation applies. Shared so a caller revalidating skill
 * authority before launch cannot drift from the check that granted it.
 */
export function isSegmentAuthorizedBySkillBins(params: {
  segment: ExecCommandSegment;
  skillBins: readonly SkillBinTrustEntry[];
}): boolean {
  return isSkillAutoAllowedSegment({
    segment: params.segment,
    allowSkills: params.skillBins.length > 0,
    skillBinTrust: buildSkillBinTrustIndex(params.skillBins),
  });
}
