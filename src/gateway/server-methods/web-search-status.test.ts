import { beforeEach, expect, it, vi } from "vitest";
import type { WebSearchStatusParams } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginWebSearchProviderEntry } from "../../plugins/web-provider-types.js";
import type { GatewayRequestContext } from "./types.js";

const mocks = vi.hoisted(() => ({
  options: vi.fn(),
  configured: vi.fn(),
  available: vi.fn(),
  selection: vi.fn(),
  metadata: vi.fn(),
  policy: vi.fn(),
  catalog: vi.fn(),
  decisions: vi.fn(),
  native: vi.fn(),
  runtime: vi.fn(),
}));
vi.mock("../../agents/auth-profiles/store.js", () => ({
  getPreparedRuntimeAuthProfileStoreSnapshot: () => undefined,
}));
vi.mock("./model-auth-agent-scope.js", () => ({
  resolveModelAuthAgentScope: () => ({ ok: true, agentId: "main", agentDir: "/synthetic/agent" }),
}));
vi.mock("../../agents/model-selection.js", () => ({
  resolveDefaultModelForAgent: () => ({ provider: "custom", model: "model" }),
}));
vi.mock("../../flows/search-setup.js", () => ({ listSearchProviderOptions: mocks.options }));
vi.mock("../../web-search/runtime.js", () => ({
  isWebSearchProviderConfigured: mocks.configured,
  listConfiguredWebSearchProviders: mocks.available,
  resolveWebSearchProviderId: mocks.selection,
}));
// mock-isolation: Provider status uses fixed metadata without loading the discovery registry.
vi.mock("../../config/io.plugin-metadata.js", () => ({
  resolveConfigWidePluginMetadataSnapshotAsync: mocks.metadata,
}));
// mock-isolation: Use fixed discovery policy without opening machine state for status projection.
vi.mock("../../plugins/bundled-discovery-state.js", () => ({
  prepareBundledDiscoveryMode: async () => () => {},
  readBundledDiscoveryModeMemoized: () => undefined,
}));
vi.mock("../../plugins/credential-descriptors.js", () => ({
  resolvePluginCredentialDescriptors: () => [credential],
}));
vi.mock("../../config/runtime-snapshot.js", () => ({
  getRuntimeConfigSourceSnapshot: () => undefined,
}));
vi.mock("../../agents/tools/model-config.helpers.js", () => ({
  hasAuthProfileForProvider: () => false,
}));
vi.mock("../../agents/web-search-tool-policy.js", () => ({
  resolveWebSearchToolPolicy: mocks.policy,
}));
vi.mock("../server-model-catalog-auth.js", () => ({ readPreparedCatalog: mocks.catalog }));
// mock-isolation: Provider status uses catalog fixtures without opening unrelated credential stores.
vi.mock("../../agents/model-catalog-decisions.js", () => ({
  prepareModelCatalogDecisions: mocks.decisions,
  resolveCatalogDecisionRuntime: mocks.runtime,
}));
vi.mock("../../agents/native-web-search.js", () => ({ resolveNativeWebSearchRoute: mocks.native }));
import { prepareWebSearchStatus } from "./web-search-status.js";

let config: OpenClawConfig;
const secret = "synthetic-key-never-return";
const credential = {
  path: ["plugins", "entries", "example", "config", "webSearch", "apiKey"],
  label: "Example key",
  envVars: [],
};
function provider(
  overrides: Partial<PluginWebSearchProviderEntry> = {},
): PluginWebSearchProviderEntry {
  return {
    id: "example",
    pluginId: "example",
    label: "Example Search",
    hint: "Search provider",
    envVars: [],
    placeholder: "key",
    signupUrl: "https://example.com/signup",
    credentialPath: credential.path.join("."),
    getCredentialValue: () => undefined,
    setCredentialValue: () => {},
    getConfiguredCredentialValue: () => secret,
    createTool: () => null,
    ...overrides,
  };
}
async function readStatus(params: WebSearchStatusParams = {}, profileId?: string) {
  const context = { getRuntimeConfig: () => config } as GatewayRequestContext;
  return (await prepareWebSearchStatus(context, params, profileId)).status;
}
const nativeRoute = {
  kind: "native",
  provider: "fixture-search",
  label: "Native web search",
  testable: false,
};
const unavailableRoute = {
  kind: "unavailable",
  label: "Model search route is not ready",
  testable: false,
};
const testProvider = { id: "example", label: "Example Search" };
beforeEach(() => {
  vi.clearAllMocks();
  config = { tools: { web: { search: { provider: "example" } } } };
  mocks.options.mockReturnValue([provider()]);
  mocks.available.mockReturnValue([provider()]);
  mocks.configured.mockReturnValue(true);
  mocks.selection.mockReturnValue("example");
  mocks.metadata.mockReturnValue({ byPluginId: new Map([["example", { id: "example" }]]) });
  mocks.policy.mockReturnValue({ allowed: true });
  mocks.native.mockReturnValue({ kind: "managed" });
  mocks.runtime.mockReturnValue({ id: "openclaw" });
  mocks.decisions.mockReturnValue({
    evaluateEntry: () => ({}),
    evaluateNative: (_entry: unknown, host: unknown) => host,
  });
  mocks.catalog.mockResolvedValue({
    entries: [{ provider: "custom", id: "model" }],
    routeVariants: [],
    metadataSnapshot: {},
    authStore: {},
    isCurrent: () => true,
  });
});

it.each(["missing-catalog", "unknown-model", "native"])(
  "projects the %s route independently of the service probe",
  async (scenario) => {
    if (scenario === "missing-catalog") {
      mocks.catalog.mockResolvedValue(undefined);
    }
    if (scenario === "native") {
      mocks.native.mockReturnValue({
        kind: "native",
        provider: "fixture-search",
        transport: "fixture-responses",
      });
    }
    const params = {
      modelProvider: "custom",
      modelId: scenario === "unknown-model" ? "unknown" : "model",
    };
    const result = await readStatus(scenario === "missing-catalog" ? {} : params);
    expect(result).toMatchObject({
      model:
        scenario === "native"
          ? { provider: "custom", id: "model", runtime: "openclaw" }
          : { runtime: "unknown" },
      route: scenario === "native" ? nativeRoute : unavailableRoute,
      testProvider: { id: "example" },
    });
  },
);

it("uses the authenticated requester's existing model account decision", async () => {
  mocks.decisions.mockImplementation(({ requesterProfileId }: { requesterProfileId?: string }) => ({
    evaluateEntry: () => ({
      runtimeAuth: { id: requesterProfileId === "personal" ? "custom-harness" : "openclaw" },
    }),
    evaluateNative: (_entry: unknown, host: unknown) => host,
  }));
  mocks.runtime.mockImplementation(
    ({ evaluation }: { evaluation: { runtimeAuth: { id: string } } }) => evaluation.runtimeAuth,
  );
  expect((await readStatus())?.route.kind).toBe("managed");
  expect(await readStatus({}, "personal")).toMatchObject({
    model: { runtime: "custom-harness" },
    route: { kind: "external", testable: false },
    testProvider: { id: "example" },
  });
});

it.each([
  ["config", secret],
  ["missing", undefined],
  ["secretRef", { source: "file", provider: "vault", id: "/private/secret" }],
] as const)("redacts %s credentials", async (source, value) => {
  const configured = source !== "missing";
  mocks.configured.mockReturnValue(configured);
  mocks.options.mockReturnValue([provider({ getConfiguredCredentialValue: () => value })]);
  mocks.available.mockReturnValue(mocks.options());
  const result = await readStatus();
  expect(result).toMatchObject({
    provider: "example",
    route: { kind: "managed", provider: "example", testable: true },
    testProvider,
    providers: [
      {
        configured,
        installed: true,
        available: true,
        credentialSource: source,
        credential,
        configPath: ["plugins", "entries", "example", "config", "webSearch"],
      },
    ],
  });
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(result)).not.toContain("/private/secret");
  if (!configured) {
    expect(result?.route.reason).toEqual(expect.stringContaining("credentials"));
  }
});

it.each([false, true])("isolates key-free setup (installed=%s)", async (installed) => {
  config = {};
  mocks.options.mockReturnValue([
    provider({ id: "keyfree", requiresCredential: false, credentialPath: "" }),
  ]);
  mocks.metadata.mockReturnValue({
    byPluginId: new Map(installed ? [["example", { id: "example" }]] : []),
  });
  mocks.available.mockReturnValue([]);
  mocks.selection.mockReturnValue("");
  const result = await readStatus();
  expect(result).toMatchObject({
    provider: null,
    route: { kind: "unavailable", testable: false },
    providers: [{ id: "keyfree", installed, available: false, credentialSource: "none" }],
  });
  expect([result?.testProvider, result?.providers[0]?.credential]).toEqual([undefined, undefined]);
});

it("projects only the provider-owned configuration subtree", async () => {
  mocks.options.mockReturnValue([
    provider({ id: "free", configPath: null, credentialPath: "", requiresCredential: false }),
    provider({ id: "custom", configPath: ["customSearch"] }),
  ]);
  mocks.available.mockReturnValue([]);
  const result = await readStatus();
  expect(result?.providers.find((entry) => entry.id === "free")?.configPath).toEqual([]);
  expect(result?.providers.find((entry) => entry.id === "custom")?.configPath).toEqual([
    ...credential.path.slice(0, 4),
    "customSearch",
  ]);
});

it.each([false, true])(
  "disables probes by global or tool policy (global=%s)",
  async (globalEnabled) => {
    config = { tools: { web: { search: { enabled: globalEnabled, provider: "example" } } } };
    mocks.policy.mockReturnValue({ allowed: !globalEnabled });
    const result = await readStatus();
    expect(result?.route).toMatchObject({ kind: "disabled", testable: false });
    expect(result?.testProvider).toBeUndefined();
    expect(mocks.catalog).not.toHaveBeenCalled();
  },
);
