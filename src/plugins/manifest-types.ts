export type PluginConfigUiHint = {
  label?: string;
  help?: string;
  tags?: string[];
  advanced?: boolean;
  sensitive?: boolean;
  placeholder?: string;
  /**
   * Include this field in QuickStart onboarding.
   *
   * Omit for the default behavior: the field stays available in the normal
   * plugin setup/configure surfaces without adding extra QuickStart prompts.
   */
  quickstart?: boolean;
};

export type PluginFormat = "openclaw" | "bundle";

export type PluginBundleFormat = "codex" | "claude" | "cursor";

export type PluginDiagnostic = {
  level: "warn" | "error";
  message: string;
  pluginId?: string;
  source?: string;
};
