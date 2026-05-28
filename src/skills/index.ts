import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import type { SkillsInstallPreferences } from "./types.js";

export {
  hasBinary,
  isBundledSkillAllowed,
  isConfigPathTruthy,
  resolveBundledAllowlist,
  resolveConfigPath,
  resolveRuntimePlatform,
  resolveSkillConfig,
} from "./config.js";
export { applySkillEnvOverrides, applySkillEnvOverridesFromSnapshot } from "./env-overrides.js";
export type {
  OpenClawSkillMetadata,
  SkillEligibilityContext,
  SkillCommandSpec,
  SkillEntry,
  SkillInstallSpec,
  SkillSnapshot,
  SkillTelemetrySource,
  SkillsInstallPreferences,
} from "./types.js";
export {
  buildWorkspaceSkillsPrompt,
  filterWorkspaceSkillEntries,
  filterWorkspaceSkillEntriesWithOptions,
  loadWorkspaceSkillEntries,
  resolveSkillsPromptForRun,
  syncSkillsToWorkspace,
} from "./workspace.js";
export { buildWorkspaceSkillCommandSpecs } from "./command-specs.js";
export type {
  LoadSkillsFromDirOptions,
  LoadSkillsOptions,
  LoadSkillsResult,
  Skill,
  SkillFrontmatter,
} from "./session.js";
export { formatSkillsForPrompt as formatSessionSkillsForPrompt, loadSkills } from "./session.js";
export type { SkillIndex, SkillIndexEntry } from "./registry.js";
export { buildSkillIndex, skillIndexEntries, skillIndexResolvedSkills } from "./registry.js";
export type { SkillSourceKind, SkillTrustInfo, SkillWritablePolicy } from "./trust.js";
export {
  classifySkillSourceKind,
  resolveSkillOwner,
  resolveSkillTrustInfo,
  resolveSkillWritablePolicy,
} from "./trust.js";
export type { SkillIndexRequest, SkillSnapshotBuildOptions } from "./service.js";
export {
  SkillsService,
  buildSkillIndexCacheKey,
  buildSkillSnapshotFromIndex,
  buildWorkspaceSkillSnapshot,
  skillsService,
} from "./service.js";

export function resolveSkillsInstallPreferences(config?: OpenClawConfig): SkillsInstallPreferences {
  const raw = config?.skills?.install;
  const preferBrew = raw?.preferBrew ?? true;
  const manager = normalizeLowercaseStringOrEmpty(normalizeOptionalString(raw?.nodeManager));
  const nodeManager: SkillsInstallPreferences["nodeManager"] =
    manager === "pnpm" || manager === "yarn" || manager === "bun" || manager === "npm"
      ? manager
      : "npm";
  return { preferBrew, nodeManager };
}
