import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { hasConfiguredSecretInput } from "../../config/types.secrets.js";
import type { SkillConfig } from "../../config/types.skills.js";
import {
  findActiveDegradedSecretOwner,
  listActiveDegradedSecretOwners,
} from "../../secrets/runtime-degraded-state.js";
import {
  evaluateRuntimeEligibility,
  hasBinary,
  isConfigPathTruthyWithDefaults,
  prepareBinaryAvailability,
} from "../../shared/config-eval.js";
import type { SkillEligibilityContext, SkillEntry, SkillsInstallPreferences } from "../types.js";
import { resolveSkillKey } from "./frontmatter.js";
import { resolveSkillSource } from "./source.js";
import type { WorkspaceSkillSources } from "./workspace-skill-sources.js";

const DEFAULT_CONFIG_VALUES: Record<string, boolean> = {
  "browser.enabled": true,
  "browser.evaluateEnabled": true,
};

export { hasBinary };

export function resolveSkillsInstallPreferences(config?: OpenClawConfig): SkillsInstallPreferences {
  const raw = config?.skills?.install;
  const preferBrew = raw?.preferBrew ?? true;
  const manager = normalizeLowercaseStringOrEmpty(raw?.nodeManager);
  const nodeManager: SkillsInstallPreferences["nodeManager"] =
    manager === "pnpm" || manager === "yarn" || manager === "bun" || manager === "npm"
      ? manager
      : "npm";
  return { preferBrew, nodeManager };
}

export function isSkillConfigPathTruthy(
  config: OpenClawConfig | undefined,
  pathStr: string,
): boolean {
  return isConfigPathTruthyWithDefaults(config, pathStr, DEFAULT_CONFIG_VALUES);
}

export function resolveSkillConfig(
  config: OpenClawConfig | undefined,
  skillKey: string,
): SkillConfig | undefined {
  const skills = config?.skills?.entries;
  if (!skills || typeof skills !== "object") {
    return undefined;
  }
  const entry = skills[skillKey];
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  return entry;
}

/** Returns whether cold startup isolated this exact skill's configured secret. */
export function isSkillSecretOwnerUnavailable(skillKey: string): boolean {
  return Boolean(findActiveDegradedSecretOwner("capability", `skill:${skillKey}`));
}

/** Returns whether cold startup isolated any configured skill secret. */
export function hasUnavailableSkillSecretOwners(): boolean {
  return listActiveDegradedSecretOwners().some(
    (owner) =>
      owner.degradationState !== "stale" &&
      owner.ownerKind === "capability" &&
      owner.ownerId.startsWith("skill:"),
  );
}

export function isSkillEnvRequirementSatisfied(params: {
  envName: string;
  skillConfig?: SkillConfig;
  primaryEnv?: string;
}): boolean {
  const { envName, skillConfig, primaryEnv } = params;
  return (
    normalizeOptionalString(process.env[envName]) !== undefined ||
    normalizeOptionalString(skillConfig?.env?.[envName]) !== undefined ||
    (primaryEnv === envName && hasConfiguredSecretInput(skillConfig?.apiKey))
  );
}

const BUNDLED_SOURCES = new Set(["openclaw-bundled", "openclaw-custodian"]);

export function resolveBundledAllowlist(config?: OpenClawConfig): ReadonlySet<string> | undefined {
  const input = config?.skills?.allowBundled;
  const normalized = Array.isArray(input) ? normalizeStringEntries(input) : [];
  return normalized.length > 0 ? new Set(normalized) : undefined;
}

export function isBundledSkillAllowed(entry: SkillEntry, allowlist?: ReadonlySet<string>): boolean {
  if (!allowlist || allowlist.size === 0) {
    return true;
  }
  if (!BUNDLED_SOURCES.has(resolveSkillSource(entry.skill))) {
    return true;
  }
  const key = resolveSkillKey(entry.skill, entry);
  return allowlist.has(key) || allowlist.has(entry.skill.name);
}

export function shouldIncludeSkill(params: {
  entry: SkillEntry;
  config?: OpenClawConfig;
  bundledAllowlist: ReadonlySet<string> | undefined;
  eligibility?: SkillEligibilityContext;
  hasBin?: (bin: string) => boolean;
  platform?: string;
}): boolean {
  const { entry, config, bundledAllowlist, eligibility } = params;
  const skillKey = resolveSkillKey(entry.skill, entry);
  const skillConfig = resolveSkillConfig(config, skillKey);

  if (skillConfig?.enabled === false) {
    return false;
  }
  if (isSkillSecretOwnerUnavailable(skillKey)) {
    return false;
  }
  if (!isBundledSkillAllowed(entry, bundledAllowlist)) {
    return false;
  }
  return evaluateRuntimeEligibility({
    os: entry.metadata?.os,
    platform: params.platform,
    remotePlatforms: eligibility?.remote?.platforms,
    always: entry.metadata?.always,
    requires: entry.metadata?.requires,
    hasBin: params.hasBin ?? hasBinary,
    hasRemoteBin: eligibility?.remote?.hasBin,
    hasAnyRemoteBin: eligibility?.remote?.hasAnyBin,
    hasEnv: (envName) =>
      isSkillEnvRequirementSatisfied({
        envName,
        skillConfig,
        primaryEnv: entry.metadata?.primaryEnv,
      }),
    isConfigPathTruthy: (configPath) => isSkillConfigPathTruthy(config, configPath),
  });
}

export async function prepareSkillBinaryProbe(
  entries: SkillEntry[],
  opts?: { config?: OpenClawConfig; eligibility?: SkillEligibilityContext },
  assertCurrent?: () => void,
  runtime?: WorkspaceSkillSources["runtime"],
) {
  if (runtime) {
    const available = new Set(runtime.bins);
    return { hasBin: (bin: string) => available.has(bin), needsRetry: () => false };
  }
  const bins = new Set<string>();
  const bundledAllowlist = resolveBundledAllowlist(opts?.config);
  let needsBinaries: boolean;
  const recordBinaryRequirement = () => {
    needsBinaries = true;
    return true;
  };
  for (const entry of entries) {
    const requires = entry.metadata?.requires;
    if (!requires?.bins?.length && !requires?.anyBins?.length) {
      continue;
    }
    needsBinaries = false;
    shouldIncludeSkill({
      entry,
      config: opts?.config,
      bundledAllowlist,
      eligibility: opts?.eligibility,
      hasBin: recordBinaryRequirement,
    });
    if (needsBinaries) {
      for (const bin of entry.metadata?.requires?.bins ?? []) {
        bins.add(bin);
      }
      for (const bin of entry.metadata?.requires?.anyBins ?? []) {
        bins.add(bin);
      }
    }
  }
  const facts = await prepareBinaryAvailability(bins, assertCurrent);
  let unprepared = false;
  return {
    hasBin: (bin: string) => {
      // Eligibility can change while probing; prepare newly requested facts before publishing.
      if (!bins.has(bin)) {
        unprepared = true;
        return false;
      }
      return facts.hasBinary(bin);
    },
    needsRetry: () => unprepared || !facts.isCurrent(),
  };
}
