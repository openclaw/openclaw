import { beforeEach, expect, it, vi } from "vitest";
import { listProfilesForProvider } from "../../agents/auth-profiles/profile-list.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createWebSearchTestProvider } from "../../test-utils/web-provider-runtime.test-helpers.js";
import type { GatewayRequestContext } from "./types.js";

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn<() => AuthProfileStore | undefined>(),
  persistedAuth: vi.fn(() => {
    throw new Error("Search status read persisted auth");
  }),
  providers: vi.fn(),
  catalog: vi.fn(),
}));
vi.mock("../../agents/model-auth.js", () => ({}));
vi.mock("../../agents/auth-profiles/external-cli-sync.js", () => ({}));
vi.mock("../../agents/auth-profiles/oauth-shared.js", () => ({}));
vi.mock("../../web-search/runtime-execution.js", () => ({}));
vi.mock("../../agents/auth-profiles/store.js", () => ({
  getPreparedRuntimeAuthProfileStoreSnapshot: mocks.snapshot,
}));
vi.mock("../../agents/auth-profiles.js", () => ({
  hasAnyAuthProfileStoreSource: mocks.persistedAuth,
  ensureAuthProfileStore: mocks.persistedAuth,
  ensureAuthProfileStoreWithoutExternalProfiles: mocks.persistedAuth,
  listProfilesForProvider: (store: AuthProfileStore, provider: string) =>
    listProfilesForProvider(store, provider),
}));
vi.mock("../../agents/auth-profiles/store-runtime.js", () => ({
  ensureAuthProfileStore: mocks.persistedAuth,
}));
vi.mock("./model-auth-agent-scope.js", () => ({
  resolveModelAuthAgentScope: () => ({ ok: true, agentId: "main", agentDir: "/synthetic/agent" }),
}));
vi.mock("../../agents/model-selection.js", () => ({
  resolveDefaultModelForAgent: () => ({ provider: "openai", model: "model" }),
}));
vi.mock("../../flows/search-setup.js", () => ({ listSearchProviderOptions: mocks.providers }));
vi.mock("../../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: mocks.providers,
}));
vi.mock("../../plugins/management-service.js", () => ({
  resolveManagedPluginMetadata: () => ({ byPluginId: new Map() }),
}));
vi.mock("../../agents/web-search-tool-policy.js", () => ({
  resolveWebSearchToolPolicy: () => ({ allowed: true }),
}));
vi.mock("../../plugins/provider-public-artifacts.js", () => ({
  resolveProviderPolicySurface: () => undefined,
}));
vi.mock("../server-model-catalog-auth.js", () => ({ readPreparedCatalog: mocks.catalog }));
vi.mock("../../agents/model-catalog-decisions.js", () => ({
  createModelCatalogDecisions: () => ({
    evaluateEntry: async () => ({}),
    evaluateNative: () => ({}),
  }),
  resolveCatalogDecisionRuntime: () => ({ id: "openclaw" }),
}));
import { prepareWebSearchStatus } from "./web-search-status.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.providers.mockReturnValue([
    createWebSearchTestProvider({
      id: "example",
      pluginId: "example",
      authProviderId: "openai",
      credentialPath: "plugins.entries.example.config.webSearch.apiKey",
      getConfiguredCredentialValue: () => undefined,
    }),
  ]);
  mocks.catalog.mockImplementation(async () => ({
    entries: [{ provider: "openai", id: "model", api: "openai-chatgpt-responses" }],
    routeVariants: [],
    metadataSnapshot: {},
    isCurrent: () => true,
    authStore: mocks.snapshot() ?? { version: 1, profiles: {} },
  }));
});

it.each([false, true])(
  "projects prepared auth without persisted fallback (published=%s)",
  async (published) => {
    mocks.snapshot.mockReturnValue(
      published
        ? {
            version: 1,
            profiles: {
              "openai:fixture": {
                type: "token",
                provider: "openai",
                token: "synthetic-fixture-token",
              },
            },
          }
        : undefined,
    );
    const config: OpenClawConfig = {
      tools: { web: { search: { openaiCodex: { enabled: true } } } },
    };
    const result = await prepareWebSearchStatus(
      { getRuntimeConfig: () => config } as GatewayRequestContext,
      {},
    );
    expect(result.status?.providers).toMatchObject([
      {
        id: "example",
        configured: published,
        credentialSource: published ? "auth-profile" : "missing",
      },
    ]);
    expect(result.status?.route.kind).toBe(published ? "native" : "unavailable");
    expect(mocks.persistedAuth).not.toHaveBeenCalled();
    expect(JSON.stringify(result.status)).not.toContain("synthetic-fixture-token");
  },
);
