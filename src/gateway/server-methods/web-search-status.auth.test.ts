import { beforeEach, expect, it, vi } from "vitest";
import { lazyCompile } from "../../../packages/gateway-protocol/src/protocol-validator.js";
import { WebSearchStatusResultSchema } from "../../../packages/gateway-protocol/src/schema/web-search.js";
import { listProfilesForProvider } from "../../agents/auth-profiles/profile-list.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createWebSearchTestProvider } from "../../test-utils/web-provider-runtime.test-helpers.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn<() => AuthProfileStore | undefined>(),
  persistedAuth: vi.fn(() => {
    throw new Error("Search status read persisted auth");
  }),
  providers: vi.fn(),
  catalog: vi.fn(),
}));
vi.mock("../../agents/model-auth.js", () => ({}));
// mock-isolation: Status health must not read machine CLI credential files.
vi.mock("../../agents/auth-profiles/external-cli-sync.js", () => ({
  readExternalCliBootstrapCredential: () => null,
}));
vi.mock("../../agents/auth-profiles/oauth-shared.js", () => ({}));
vi.mock("../../agents/auth-profiles/store.js", () => ({
  getPreparedRuntimeAuthProfileStoreSnapshot: mocks.snapshot,
}));
// mock-isolation: Any persisted read violates this prepared-auth status contract.
vi.mock("../../agents/auth-profiles.js", () => ({
  hasAnyAuthProfileStoreSource: mocks.persistedAuth,
  ensureAuthProfileStore: mocks.persistedAuth,
  ensureAuthProfileStoreAsync: mocks.persistedAuth,
  ensureAuthProfileStoreWithoutExternalProfiles: mocks.persistedAuth,
  ensureAuthProfileStoreWithoutExternalProfilesAsync: mocks.persistedAuth,
  listProfilesForProvider: (store: AuthProfileStore, provider: string) =>
    listProfilesForProvider(store, provider),
}));
// mock-isolation: Any persisted read violates this prepared-auth status contract.
vi.mock("../../agents/auth-profiles/store-runtime.js", () => ({
  ensureAuthProfileStore: mocks.persistedAuth,
  ensureAuthProfileStoreAsync: mocks.persistedAuth,
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
// mock-isolation: Prepared-auth status uses fixed metadata without loading the discovery registry.
vi.mock("../../config/io.plugin-metadata.js", () => ({
  resolveConfigWidePluginMetadataSnapshotAsync: async () => ({ byPluginId: new Map() }),
}));
// mock-isolation: Use fixed discovery policy without opening machine state for status projection.
vi.mock("../../plugins/bundled-discovery-state.js", () => ({
  prepareBundledDiscoveryMode: async () => () => {},
  readBundledDiscoveryModeMemoized: () => undefined,
}));
vi.mock("../../agents/web-search-tool-policy.js", () => ({
  resolveWebSearchToolPolicy: () => ({ allowed: true }),
}));
vi.mock("../../plugins/provider-public-artifacts.js", () => ({
  resolveProviderPolicySurface: () => undefined,
}));
vi.mock("../server-model-catalog-auth.js", () => ({ readPreparedCatalog: mocks.catalog }));
// mock-isolation: Keep catalog initialization outside this prepared-auth boundary test.
vi.mock("../../agents/model-catalog-decisions.js", () => ({
  prepareModelCatalogDecisions: async () => ({
    evaluateEntry: () => ({}),
    evaluateNative: () => ({}),
  }),
  resolveCatalogDecisionRuntime: () => ({ id: "openclaw" }),
}));
// mock-isolation: Prepared-auth projection admits a synthetic requester without an identity database.
vi.mock("./users-profile-access.js", () => ({
  prepareAuthenticatedProfile: async () => ({ assertCurrent: () => {} }),
}));
import { webSearchHandlers } from "./web-search.js";

const validateStatus = lazyCompile(WebSearchStatusResultSchema);

const readStatus = async (config: OpenClawConfig) => {
  const context = { getRuntimeConfig: () => config } as GatewayRequestContext;
  const params = {};
  const respond = vi.fn<GatewayRequestHandlerOptions["respond"]>();
  await webSearchHandlers["webSearch.status"]!({
    req: { type: "req", id: "search-status", method: "webSearch.status" },
    params,
    client: {
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "gateway-client", version: "test", platform: "test", mode: "backend" },
        scopes: ["operator.read"],
      },
    },
    context,
    respond,
    isWebchatConnect: () => false,
  });
  expect(respond).toHaveBeenCalledTimes(1);
  const [ok, payload, error] = respond.mock.calls[0] ?? [];
  expect([ok, error]).toEqual([true, undefined]);
  if (!validateStatus(payload)) {
    throw new Error(JSON.stringify(validateStatus.errors));
  }
  return payload;
};
const publishProfile = (profile: AuthProfileStore["profiles"][string] | undefined) =>
  mocks.snapshot.mockReturnValue(
    profile ? { version: 1, profiles: { "openai:fixture": profile } } : undefined,
  );

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
    publishProfile(
      published
        ? {
            type: "token",
            provider: "openai",
            token: "synthetic-fixture-token",
          }
        : undefined,
    );
    const config: OpenClawConfig = {
      tools: { web: { search: { openaiCodex: { enabled: true } } } },
    };
    const status = await readStatus(config);
    expect(status?.providers).toMatchObject([
      {
        id: "example",
        configured: published,
        credentialSource: published ? "auth-profile" : "missing",
      },
    ]);
    // Native search follows the selected transport; the model request admits credentials.
    expect(status?.route.kind).toBe("native");
    expect(mocks.persistedAuth).not.toHaveBeenCalled();
    expect(JSON.stringify(status)).not.toContain("synthetic-fixture-token");
  },
);

it.each([
  { expires: Date.now() - 60_000, reported: true },
  { expires: Date.now() + 24 * 60 * 60_000, reported: false },
])(
  "reports a search provider's expired sign-in from shared auth health (expired=$reported)",
  async ({ expires, reported }) => {
    publishProfile({
      type: "oauth",
      provider: "openai",
      access: "synthetic-access-token",
      refresh: "synthetic-refresh-token",
      expires,
    });
    mocks.catalog.mockResolvedValueOnce(undefined);
    const config: OpenClawConfig = { tools: { web: { search: { provider: "example" } } } };
    const status = await readStatus(config);

    expect(status?.providers).toMatchObject([{ id: "example", credentialSource: "auth-profile" }]);
    expect(status?.testProvider).toMatchObject({ id: "example" });
    const reason = status?.route.reason ?? "";
    expect(reason.includes("The openai sign-in this provider uses is expired.")).toBe(reported);
    expect(reason.includes("send `/login openai` from a private chat")).toBe(reported);
    expect(reason.includes("openclaw models auth login --provider openai")).toBe(reported);
    expect(JSON.stringify(status)).not.toMatch(/synthetic-|openai:fixture/);
  },
);
