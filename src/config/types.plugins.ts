export type PluginEntryConfig = {
  enabled?: boolean;
  config?: Record<string, unknown>;
};

export type PluginSlotsConfig = {
  /** Select which plugin owns the memory slot ("none" disables memory plugins). */
  memory?: string;
};

export type PluginsLoadConfig = {
  /** Additional plugin/extension paths to load. */
  paths?: string[];
};

export type PluginsRuntimeConfig = {
  /**
   * Re-enable deprecated runtime.system.runCommandWithTimeout for legacy plugins.
   * Disabled by default for security hardening.
   */
  allowLegacyExec?: boolean;
};

export type PluginInstallRecord = {
  source: "npm" | "archive" | "path";
  spec?: string;
  sourcePath?: string;
  installPath?: string;
  version?: string;
  installedAt?: string;
};

export type PluginsConfig = {
  /** Enable or disable plugin loading. */
  enabled?: boolean;
  /** Optional plugin allowlist (plugin ids). */
  allow?: string[];
  /** Optional plugin denylist (plugin ids). */
  deny?: string[];
  load?: PluginsLoadConfig;
  runtime?: PluginsRuntimeConfig;
  slots?: PluginSlotsConfig;
  entries?: Record<string, PluginEntryConfig>;
  installs?: Record<string, PluginInstallRecord>;
};
