export type PluginEntryConfig = {
  enabled?: boolean;
  hooks?: {
    /** Controls prompt mutation via before_prompt_build and prompt fields from legacy before_agent_start. */
    allowPromptInjection?: boolean;
  };
  config?: Record<string, unknown>;
};

export type PluginSlotsConfig = {
  /** Select which plugin owns the memory slot ("none" disables memory plugins). */
  memory?: string;
  /** Select which plugin owns the context-engine slot. */
  contextEngine?: string;
};

export type PluginsLoadConfig = {
  /** Additional plugin/extension paths to load. */
  paths?: string[];
};

export type PluginInstallRecord = InstallRecordBase;

export type PluginsConfig = {
  /** Enable or disable plugin loading. */
  enabled?: boolean;
  /** Optional plugin allowlist (plugin ids). */
  allow?: string[];
  /** Optional plugin denylist (plugin ids). */
  deny?: string[];
  load?: PluginsLoadConfig;
  slots?: PluginSlotsConfig;
  entries?: Record<string, PluginEntryConfig>;
  installs?: Record<string, PluginInstallRecord>;
};
import type { InstallRecordBase } from "./types.installs.js";
