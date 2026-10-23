type ConfiguredRuntimePluginInstallCandidate = {
  pluginId: string;
  label: string;
  npmSpec: string;
  trustedSourceLinkedOfficialInstall: true;
  /** Keep this official runtime package on the same release cohort as OpenClaw. */
  versionBoundToOpenClaw?: boolean;
  minimumCompatibleVersion?: string;
};

export const CONFIGURED_RUNTIME_PLUGIN_INSTALL_CANDIDATES: readonly ConfiguredRuntimePluginInstallCandidate[] =
  [
    {
      pluginId: "acpx",
      label: "ACPX Runtime",
      npmSpec: "@openclaw/acpx",
      trustedSourceLinkedOfficialInstall: true,
    },
    // Runtime-only configs do not have a provider/channel integration catalog entry.
    {
      pluginId: "codex",
      label: "Codex",
      npmSpec: "@openclaw/codex",
      trustedSourceLinkedOfficialInstall: true,
      versionBoundToOpenClaw: true,
      // Bump this floor when a Plugin SDK subpath used by this runtime is removed.
      minimumCompatibleVersion: "2026.9.7",
    },
  ];

export const VERSION_BOUND_RUNTIME_PLUGIN_IDS: ReadonlySet<string> = new Set(
  CONFIGURED_RUNTIME_PLUGIN_INSTALL_CANDIDATES.filter(
    (candidate) => candidate.versionBoundToOpenClaw,
  ).map((candidate) => candidate.pluginId),
);

export const VERSION_BOUND_RUNTIME_PLUGIN_POLICY_IDS_BY_SURFACE = {
  allow: VERSION_BOUND_RUNTIME_PLUGIN_IDS,
  deny: VERSION_BOUND_RUNTIME_PLUGIN_IDS,
  entries: VERSION_BOUND_RUNTIME_PLUGIN_IDS,
} as const;

/** Resolve the official install candidate for a configured runtime id. */
export function resolveConfiguredRuntimePluginInstallCandidate(
  runtimeId: string,
): ConfiguredRuntimePluginInstallCandidate | undefined {
  return CONFIGURED_RUNTIME_PLUGIN_INSTALL_CANDIDATES.find(
    (candidate) => candidate.pluginId === runtimeId,
  );
}
