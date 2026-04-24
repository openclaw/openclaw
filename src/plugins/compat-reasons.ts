export const PLUGIN_COMPAT_REASON = {
  legacyActivationField: "legacy-activation-field",
  legacySetupApi: "legacy-setup-api",
  legacyRootSdkImport: "legacy-root-sdk-import",
  legacyGlobalRegistry: "legacy-global-registry",
  legacyManifestOwnerFallback: "legacy-manifest-owner-fallback",
  legacyHookStage: "legacy-hook-stage",
} as const;

export type PluginCompatReason = (typeof PLUGIN_COMPAT_REASON)[keyof typeof PLUGIN_COMPAT_REASON];
