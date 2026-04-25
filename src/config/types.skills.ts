import type { SecretInput } from "./types.secrets.js";

export type SkillConfig = {
  enabled?: boolean;
  apiKey?: SecretInput;
  env?: Record<string, string>;
  config?: Record<string, unknown>;
};

export type SkillsLoadConfig = {
  /**
   * Additional skill folders to scan (lowest precedence).
   * Each directory should contain skill subfolders with `SKILL.md`.
   */
  extraDirs?: string[];
  /** Watch skill folders for changes and refresh the skills snapshot. */
  watch?: boolean;
  /** Debounce for the skills watcher (ms). */
  watchDebounceMs?: number;
};

export type SkillsInstallConfig = {
  preferBrew?: boolean;
  nodeManager?: "npm" | "pnpm" | "yarn" | "bun";
};

export type SkillsLimitsConfig = {
  /** Max number of immediate child directories to consider under a skills root before treating it as suspicious. */
  maxCandidatesPerRoot?: number;
  /** Max number of skills to load per skills source (bundled/managed/workspace/extra). */
  maxSkillsLoadedPerSource?: number;
  /** Max number of skills to include in the model-facing skills prompt. */
  maxSkillsInPrompt?: number;
  /** Max characters for the model-facing skills prompt block (approx). */
  maxSkillsPromptChars?: number;
  /** Max size (bytes) allowed for a SKILL.md file to be considered. */
  maxSkillFileBytes?: number;
};

export type SkillsManageAutoProposeConfig = {
  enabled?: boolean;
  maxPerSession?: number;
  cooldownMinutes?: number;
  minToolCalls?: number;
};

export type SkillsManageConfig = {
  /** When false, the skills_manage tool is omitted from the tool list. */
  enabled?: boolean;
  /** TTL for in-memory pending proposals (ms). */
  proposalTtlMs?: number;
  maxPendingProposals?: number;
  autoPropose?: SkillsManageAutoProposeConfig;
};

export type SkillsConfig = {
  /** Optional bundled-skill allowlist (only affects bundled skills). */
  allowBundled?: string[];
  load?: SkillsLoadConfig;
  install?: SkillsInstallConfig;
  limits?: SkillsLimitsConfig;
  /** Gated skill proposals (skills_manage) and optional auto-propose evaluator. */
  manage?: SkillsManageConfig;
  entries?: Record<string, SkillConfig>;
};
