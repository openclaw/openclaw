import "./web-search-runtime.test-support.js";
import { Check } from "typebox/schema";
import { beforeEach, expect, it, vi } from "vitest";
import type { WebSearchStatusParams } from "../../../packages/gateway-protocol/src/index.js";
import { createProtocolValidator } from "../../../packages/gateway-protocol/src/protocol-validator.js";
import { WebSearchStatusResultSchema } from "../../../packages/gateway-protocol/src/schema/web-search.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginWebSearchProviderEntry } from "../../plugins/web-provider-types.js";
import { createWebSearchTestProvider } from "../../test-utils/web-provider-runtime.test-helpers.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";
const { preparedWebSearchCatalog, webSearchRuntimeMocks: runtimeMocks } =
  await import("./web-search-runtime.test-support.js");

const mocks = vi.hoisted(() => ({
  options: vi.fn(),
  configured: vi.fn(),
  available: vi.fn(),
  selection: vi.fn(),
  metadata: vi.fn(),
  policy: vi.fn(),
  decisions: vi.fn(),
  native: vi.fn(),
  profile: vi.fn<() => string | undefined>(),
  search: vi.fn(),
}));
vi.mock("../../flows/search-setup.js", () => ({ listSearchProviderOptions: mocks.options }));
// mock-isolation: Keep status inputs synthetic and detect accidental search effects.
vi.mock("../../web-search/runtime.js", () => ({
  runWebSearch: mocks.search,
  isWebSearchProviderConfigured: mocks.configured,
  listConfiguredWebSearchProviders: mocks.available,
  resolveWebSearchProviderId: mocks.selection,
}));
// mock-isolation: Provider status uses fixed metadata without loading the discovery registry.
vi.doMock("../../config/io.plugin-metadata.js", () => ({
  resolveConfigWidePluginMetadataSnapshotAsync: mocks.metadata,
}));
vi.mock("../../plugins/credential-descriptors.js", () => ({
  resolvePluginCredentialDescriptors: () => [credential],
}));
vi.mock("../../agents/tools/model-config.helpers.js", () => ({
  hasAuthProfileForProvider: () => false,
}));
vi.doMock("../../agents/web-search-tool-policy.js", () => ({
  resolveWebSearchToolPolicy: mocks.policy,
}));
// mock-isolation: Provider status uses catalog fixtures without opening unrelated credential stores.
vi.doMock("../../agents/model-catalog-decisions.js", () => ({
  prepareModelCatalogDecisions: mocks.decisions,
  resolveCatalogDecisionRuntime: runtimeMocks.runtime,
}));
// mock-isolation: Native search routing is synthetic without loading provider catalogs or credentials.
vi.doMock("../../agents/native-web-search.js", () => ({
  resolveNativeWebSearchRoute: mocks.native,
}));
// mock-isolation: Admit a synthetic requester without opening the live identity database.
vi.mock("./users-profile-access.js", () => ({
  prepareAuthenticatedProfile: async () => ({
    profileId: mocks.profile(),
    assertCurrent: () => {},
  }),
}));
const { webSearchHandlers } = await import("./web-search.js");

const validateStatus = createProtocolValidator(WebSearchStatusResultSchema, (value) =>
  Check(WebSearchStatusResultSchema, value),
);

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
    ...createWebSearchTestProvider({
      id: "example",
      pluginId: "example",
      credentialPath: credential.path.join("."),
      getConfiguredCredentialValue: () => secret,
      createTool: () => null,
    }),
    label: "Example Search",
    envVars: [],
    ...overrides,
  };
}
async function readStatus(params: WebSearchStatusParams = {}, profileId?: string) {
  const context = { getRuntimeConfig: () => config } as GatewayRequestContext;
  mocks.profile.mockReturnValue(profileId);
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
  expect(mocks.search).not.toHaveBeenCalled();
  return payload;
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
  runtimeMocks.runtime.mockReturnValue({ id: "openclaw" });
  mocks.decisions.mockReturnValue({
    evaluateEntry: () => ({}),
    evaluateNative: (_entry: unknown, host: unknown) => host,
  });
  runtimeMocks.catalog.mockResolvedValue(preparedWebSearchCatalog());
});

it.each(["missing-catalog", "unknown-model", "native"])(
  "projects the %s route independently of the service probe",
  async (scenario) => {
    if (scenario === "missing-catalog") {
      runtimeMocks.catalog.mockResolvedValue(undefined);
    }
    if (scenario === "native") {
      mocks.native.mockReturnValue({
        kind: "native",
        provider: "fixture-search",
        transport: "fixture-responses",
      });
    }
    const params = {
      modelProvider: "local",
      modelId: scenario === "unknown-model" ? "unknown" : "local-model",
    };
    const result = await readStatus(scenario === "missing-catalog" ? {} : params);
    expect(result).toMatchObject({
      model:
        scenario === "native"
          ? { provider: "local", id: "local-model", runtime: "openclaw" }
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
  runtimeMocks.runtime.mockImplementation(
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
    providers: [{ configured, credentialSource: source, credential }],
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
    expect(runtimeMocks.catalog).not.toHaveBeenCalled();
  },
);
