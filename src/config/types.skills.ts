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

export type SkillsDynamicLoadingConfig = {
  /** Enable context-aware dynamic skill loading (default: false) */
  enabled?: boolean;
  /** Number of skills to load based on relevance (default: 5) */
  topK?: number;
  /** Minimum similarity score threshold 0-1 (default: 0.3) */
  minScore?: number;
  /** Embedding provider: "openai" | "anthropic" (default: uses model config) */
  embeddingProvider?: string;
  /** Embedding model name (default: "text-embedding-3-small") */
  embeddingModel?: string;
};

export type SkillsConfig = {
  /** Optional bundled-skill allowlist (only affects bundled skills). */
  allowBundled?: string[];
  load?: SkillsLoadConfig;
  install?: SkillsInstallConfig;
  /** Context-aware dynamic skill loading configuration */
  dynamicLoading?: SkillsDynamicLoadingConfig;
  entries?: Record<string, SkillConfig>;
};
