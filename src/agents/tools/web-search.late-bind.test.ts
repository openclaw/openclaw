import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setActiveDegradedSecretOwners } from "../../secrets/runtime-degraded-state.js";
import { createWebSearchTool } from "./web-search.js";

const mocks = vi.hoisted(() => ({
  runWebSearch: vi.fn(),
  getActiveRuntimeWebToolsMetadataFromState: vi.fn(),
  getActiveSecretsRuntimeConfigSnapshot: vi.fn(),
}));

vi.mock("../../web-search/runtime.js", () => ({
  resolveWebSearchProviderId: vi.fn(() => "mock"),
  runWebSearch: mocks.runWebSearch,
}));

// mock-isolation: Search discovery does not need the full plugin registry.
vi.mock("../../plugins/plugin-registry.js", () => ({
  resolveManifestContractOwnerPluginId: vi.fn(),
}));

vi.mock("../../secrets/runtime-web-tools-state.js", () => ({
  getActiveRuntimeWebToolsMetadataFromState: mocks.getActiveRuntimeWebToolsMetadataFromState,
}));

vi.mock("../../secrets/runtime-state.js", () => ({
  getActiveSecretsRuntimeConfigSnapshot: mocks.getActiveSecretsRuntimeConfigSnapshot,
}));

function execute(options: Parameters<typeof createWebSearchTool>[0] = {}) {
  return createWebSearchTool({
    config: { tools: { web: { search: { provider: "brave" } } } },
    ...options,
  })?.execute("call-search", { query: "openclaw" }, undefined);
}

const metadata = (provider: string) => ({
  selectedProvider: provider,
  providerSource: "configured" as const,
  diagnostics: [],
});

beforeEach(() => {
  mocks.runWebSearch.mockReset().mockResolvedValue({ provider: "brave", result: { ok: true } });
  mocks.getActiveRuntimeWebToolsMetadataFromState.mockReset().mockReturnValue(null);
  mocks.getActiveSecretsRuntimeConfigSnapshot.mockReset().mockReturnValue(null);
});

afterEach(() => setActiveDegradedSecretOwners([]));

it("prefers active runtime metadata over options.runtimeWebSearch when present", async () => {
  mocks.getActiveRuntimeWebToolsMetadataFromState.mockReturnValue({
    search: metadata("perplexity"),
  });
  await execute({
    config: {},
    lateBindRuntimeConfig: true,
    runtimeWebSearch: metadata("brave"),
  });
  expect(mocks.runWebSearch.mock.calls[0]?.[0]).toMatchObject({
    runtimeWebSearch: { selectedProvider: "perplexity" },
  });
});

it("honors late-bound disabled search config at execute time", async () => {
  mocks.getActiveSecretsRuntimeConfigSnapshot.mockReturnValue({
    config: { tools: { web: { search: { enabled: false } } } },
  });
  await expect(execute({ lateBindRuntimeConfig: true })).rejects.toThrow("web_search is disabled.");
  expect(mocks.runWebSearch).not.toHaveBeenCalled();
});

it("returns typed unavailability for only the isolated search provider", async () => {
  setActiveDegradedSecretOwners([
    {
      ownerKind: "capability",
      ownerId: "web-search:brave",
      state: "unavailable",
      paths: ["plugins.entries.brave.config.webSearch.apiKey"],
      refKeys: ["env:default:MISSING_BRAVE_KEY"],
      reason: "missing test ref",
    },
  ]);
  await expect(execute()).rejects.toMatchObject({
    name: "SecretSurfaceUnavailableError",
    code: "SECRET_SURFACE_UNAVAILABLE",
    ownerKind: "capability",
    ownerId: "web-search:brave",
  });
  expect(mocks.runWebSearch).not.toHaveBeenCalled();
});
