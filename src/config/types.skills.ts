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

export type SkillsCommandDispatchConfig = {
  /**
   * Optional allowlist for skill `command-dispatch: tool` target tools.
   * Supports exact names and wildcard patterns (e.g. `gateway/*`).
   * When unset, OpenClaw applies a default denylist for high-risk tools.
   */
  allowTools?: string[];
  /** Max argument length (characters) accepted for skill tool dispatch. */
  maxArgLength?: number;
  /**
   * Optional tool allowlist that must receive JSON-object arguments.
   * Supports exact names and wildcard patterns.
   */
  requireStructuredArgsTools?: string[];
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

export type SkillsConfig = {
  /** Optional bundled-skill allowlist (only affects bundled skills). */
  allowBundled?: string[];
  load?: SkillsLoadConfig;
  install?: SkillsInstallConfig;
  commandDispatch?: SkillsCommandDispatchConfig;
  limits?: SkillsLimitsConfig;
  entries?: Record<string, SkillConfig>;
};
