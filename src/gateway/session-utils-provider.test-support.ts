// Shared row fixtures isolate provider artifact loading from session projection contracts.
import { vi } from "vitest";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";

const providerArtifactMocks = vi.hoisted(() => ({
  resolveBundledProviderPolicySurface: vi.fn<
    typeof import("../plugins/provider-public-artifacts.js").resolveBundledProviderPolicySurface
  >(() => null),
}));

vi.mock("../plugins/provider-public-artifacts.js", () => ({
  resolveBundledProviderPolicySurface: providerArtifactMocks.resolveBundledProviderPolicySurface,
  resolveProviderPolicySurface: providerArtifactMocks.resolveBundledProviderPolicySurface,
}));

export function getSessionProviderArtifactMocks() {
  return providerArtifactMocks;
}

export function resetSessionProviderArtifacts() {
  clearPluginMetadataLifecycleCaches();
  providerArtifactMocks.resolveBundledProviderPolicySurface.mockReset();
  providerArtifactMocks.resolveBundledProviderPolicySurface.mockReturnValue(null);
}
