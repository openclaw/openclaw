// Web tool runtime-context tests cover late-bound config snapshots and
// plugin-owner lookups for search/fetch provider selection.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveWebFetchToolRuntimeContext } from "./web-tool-runtime-context.js";

const mocks = vi.hoisted(() => ({
  getActiveRuntimeWebToolsMetadataFromState: vi.fn(),
  getActiveSecretsRuntimeConfigSnapshot: vi.fn(),
  resolveManifestContractOwnerPluginId: vi.fn(),
}));

vi.mock("../../plugins/plugin-registry.js", () => ({
  resolveManifestContractOwnerPluginId: mocks.resolveManifestContractOwnerPluginId,
}));

vi.mock("../../secrets/runtime-web-tools-state.js", () => ({
  getActiveRuntimeWebToolsMetadataFromState: mocks.getActiveRuntimeWebToolsMetadataFromState,
}));

vi.mock("../../secrets/runtime-state.js", () => ({
  getActiveSecretsRuntimeConfigSnapshot: mocks.getActiveSecretsRuntimeConfigSnapshot,
}));

function latestOwnerLookupParams(): Record<string, unknown> {
  // Owner lookups are the evidence for whether runtime providers stay enabled
  // or a configured plugin takes over the tool call.
  const params = mocks.resolveManifestContractOwnerPluginId.mock.calls.at(-1)?.[0];
  if (!params || typeof params !== "object") {
    throw new Error("expected owner lookup params");
  }
  return params as Record<string, unknown>;
}

describe("web tool runtime context", () => {
  beforeEach(() => {
    mocks.getActiveRuntimeWebToolsMetadataFromState.mockReset();
    mocks.getActiveRuntimeWebToolsMetadataFromState.mockReturnValue(null);
    mocks.getActiveSecretsRuntimeConfigSnapshot.mockReset();
    mocks.getActiveSecretsRuntimeConfigSnapshot.mockReturnValue(null);
    mocks.resolveManifestContractOwnerPluginId.mockReset();
    mocks.resolveManifestContractOwnerPluginId.mockReturnValue(undefined);
  });

  it("keeps runtime providers disabled for bundled fetch owners", async () => {
    mocks.resolveManifestContractOwnerPluginId.mockReturnValue("firecrawl");

    const resolved = resolveWebFetchToolRuntimeContext({
      config: { tools: { web: { fetch: { provider: "firecrawl" } } } },
    });

    expect(resolved.preferRuntimeProviders).toBe(false);
    const ownerLookup = latestOwnerLookupParams();
    expect(ownerLookup.contract).toBe("webFetchProviders");
    expect(ownerLookup.value).toBe("firecrawl");
    expect(ownerLookup.origin).toBe("bundled");
    expect(ownerLookup.config).toEqual({
      tools: { web: { fetch: { provider: "firecrawl" } } },
    });
  });

  it("keeps runtime provider discovery enabled when no provider is selected", () => {
    const resolved = resolveWebFetchToolRuntimeContext({
      config: {},
    });

    expect(resolved.preferRuntimeProviders).toBe(true);
    expect(mocks.resolveManifestContractOwnerPluginId).not.toHaveBeenCalled();
  });
});
