export type SkillConfig = {
  enabled?: boolean;
  apiKey?: string;
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

export type SkillStoreConfig = {
  /** Display name for the store (used in logs and UI). */
  name?: string;
  /** Manifest API base URL for this trusted store. */
  url: string;
  /** Optional API key (supports `${ENV_VAR}` substitution). */
  apiKey?: string;
};

export type SkillGuardSideloadPolicy = "warn" | "block-critical" | "block-all";

export type SkillGuardConfig = {
  /** Master switch, defaults to true when the guard section is present. */
  enabled?: boolean;
  /** Ordered list of trusted Skill Store endpoints. */
  trustedStores?: SkillStoreConfig[];
  /** Policy for sideloaded (non-store) skills. Defaults to "block-critical". */
  sideloadPolicy?: SkillGuardSideloadPolicy;
  /** Manifest sync interval in seconds. Defaults to 300. */
  syncIntervalSeconds?: number;
  /** Enable audit logging. Defaults to true. */
  auditLog?: boolean;
};

export type SkillsConfig = {
  /** Optional bundled-skill allowlist (only affects bundled skills). */
  allowBundled?: string[];
  load?: SkillsLoadConfig;
  install?: SkillsInstallConfig;
  entries?: Record<string, SkillConfig>;
  /** Skill Guard store verification configuration. */
  guard?: SkillGuardConfig;
};
