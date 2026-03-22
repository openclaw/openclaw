export type PrivateModeLocalOnlyConfig = {
  /**
   * Enforce local-only model providers. Defaults to true when privateMode is enabled.
   */
  enabled?: boolean;
  /**
   * Provider ids allowed for model selection in private mode.
   * Defaults to ["ollama"].
   */
  allowedProviders?: string[];
  /**
   * Fail validation when any disallowed provider is configured or referenced.
   * Defaults to true when privateMode is enabled.
   */
  failOnDisallowedProviders?: boolean;
};

export type PrivateModeEmbeddingsConfig = {
  /**
   * Allowed embeddings provider in private mode.
   */
  provider?: "local" | "ollama";
  /**
   * Allow embeddings to degrade to FTS-only when unavailable.
   * Defaults to true.
   */
  allowFtsFallback?: boolean;
};

export type PrivateModeFilesystemConfig = {
  /** Canonical host roots that private mode may expose to agents. */
  allowedRoots?: string[];
  /** Default sandbox workspace access in private mode. Prefer "none". */
  workspaceAccessDefault?: "none" | "ro" | "rw";
  /** Reject absolute paths unless they resolve within an allowed root. */
  blockAbsolutePaths?: boolean;
};

export type PrivateModeExecutionConfig = {
  disableElevatedExec?: boolean;
  sandboxMode?: "all";
  blockHostExec?: boolean;
};

export type PrivateModeSkillsConfig = {
  disableAll?: boolean;
  allowlist?: string[];
  blockEnvInjection?: boolean;
};

export type PrivateModeAuditConfig = {
  enabled?: boolean;
  logPath?: string;
  logPromptSources?: boolean;
  logFileReads?: boolean;
  logModelCalls?: boolean;
  redactContent?: boolean;
};

export type PrivateModeConfig = {
  enabled?: boolean;
  localOnly?: PrivateModeLocalOnlyConfig;
  embeddings?: PrivateModeEmbeddingsConfig;
  filesystem?: PrivateModeFilesystemConfig;
  execution?: PrivateModeExecutionConfig;
  skills?: PrivateModeSkillsConfig;
  audit?: PrivateModeAuditConfig;
};
