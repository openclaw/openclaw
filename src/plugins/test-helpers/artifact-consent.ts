import type { createManagedPluginArtifactConsentHandler } from "../capability-consent.js";

export function nonRetainingConsentFixture(): ReturnType<
  typeof createManagedPluginArtifactConsentHandler
> {
  return {
    canRetainCurrentArtifact: () => false,
    onBeforePluginArtifactCommit: async () => {},
    applyAcceptedSurface: (_pluginId, record) => record,
  };
}
