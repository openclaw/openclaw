import { vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const webSearchRuntimeMocks = vi.hoisted(() => ({ catalog: vi.fn(), runtime: vi.fn() }));
export { webSearchRuntimeMocks };

// mock-isolation: Search projection uses synthetic prepared auth without reading machine stores.
vi.mock("../../agents/auth-profiles/store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/auth-profiles/store.js")>()),
  getPreparedRuntimeAuthProfileStoreSnapshot: () => undefined,
}));
// mock-isolation: The synthetic Gateway request has one fixed agent, not machine agent state.
vi.mock("./model-auth-agent-scope.js", () => ({
  resolveModelAuthAgentScope: () => ({ ok: true, agentId: "main", agentDir: "/synthetic/agent" }),
}));
// mock-isolation: Fix model selection before exercising real search status projection.
vi.mock("../../agents/model-selection.js", () => ({
  resolveDefaultModelForAgent: () => ({ provider: "local", model: "local-model" }),
}));
// mock-isolation: This request fixture does not load the provider discovery registry.
vi.mock("../../config/io.plugin-metadata.js", () => ({
  resolveConfigWidePluginMetadataSnapshotAsync: async () => ({ byPluginId: new Map() }),
}));
// mock-isolation: Discovery policy is an input, not machine state under test here.
vi.mock("../../plugins/bundled-discovery-state.js", () => ({
  prepareBundledDiscoveryMode: async () => () => {},
  readBundledDiscoveryModeMemoized: () => undefined,
}));
vi.mock("../../config/runtime-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/runtime-snapshot.js")>()),
  getRuntimeConfigSourceSnapshot: () => undefined,
  selectLiveRuntimeConfig: (config?: OpenClawConfig) => config,
}));
// mock-isolation: Tool eligibility is fixed input; projection and handler authority stay real.
vi.mock("../../agents/web-search-tool-policy.js", () => ({
  resolveWebSearchToolPolicy: () => ({ allowed: true }),
}));
// mock-isolation: Catalog publication is fixed input; no credential/catalog initialization runs.
vi.mock("../server-model-catalog-auth.js", () => ({
  readPreparedCatalog: webSearchRuntimeMocks.catalog,
}));
// mock-isolation: Fixed catalog decisions select a runtime without initializing model accounts.
vi.mock("../../agents/model-catalog-decisions.js", () => ({
  prepareModelCatalogDecisions: async () => ({
    evaluateEntry: () => ({}),
    evaluateNative: () => ({}),
  }),
  resolveCatalogDecisionRuntime: webSearchRuntimeMocks.runtime,
}));
// mock-isolation: Use a managed model route while retaining real service probing.
vi.mock("../../agents/native-web-search.js", () => ({
  resolveNativeWebSearchRoute: () => ({ kind: "managed" }),
}));

export const preparedWebSearchCatalog = () => ({
  entries: [{ provider: "local", id: "local-model" }],
  routeVariants: [],
  metadataSnapshot: {},
  authStore: { version: 1, profiles: {} },
  isCurrent: () => true,
});
