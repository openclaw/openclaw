import { beforeEach, describe, expect, it, vi } from "vitest";
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
vi.mock("../../config/io.plugin-metadata.js", () => ({
  resolveConfigWidePluginMetadataSnapshotAsync: mocks.metadata,
}));
vi.mock("../../plugins/bundled-discovery-state.js", () => ({
  prepareBundledDiscoveryMode: async () => () => {},
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
function context() {
  return { getRuntimeConfig: () => config } as GatewayRequestContext;
}
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
    entries: [
      {
        provider: "custom",
        id: "model",
        name: "Model",
        api: "openai-responses",
        baseUrl: "https://example.com/api",
      },
    ],
    routeVariants: [],
    metadataSnapshot: {},
    authStore: {},
    isCurrent: () => true,
  });
});

describe("Search settings status projection", () => {
  it.each(["missing-catalog", "unknown-model", "native"])(
    "projects the %s model route independently of the explicit service probe",
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
      const result = await prepareWebSearchStatus(
        context(),
        scenario === "missing-catalog" ? {} : params,
      );
      expect(result.status).toMatchObject({
        model:
          scenario === "native"
            ? { provider: "custom", id: "model", runtime: "openclaw" }
            : { runtime: "unknown" },
        route:
          scenario === "native"
            ? {
                kind: "native",
                provider: "fixture-search",
                label: "Native web search",
                testable: false,
              }
            : {
                kind: "unavailable",
                label: "Model search route is not ready",
                testable: false,
              },
        testProvider: { id: "example" },
      });
    },
  );

  it("uses the authenticated requester's existing model account decision", async () => {
    mocks.decisions.mockImplementation(
      ({ requesterProfileId }: { requesterProfileId?: string }) => ({
        evaluateEntry: () => ({
          runtimeAuth: { id: requesterProfileId === "personal" ? "custom-harness" : "openclaw" },
        }),
        evaluateNative: (_entry: unknown, host: unknown) => host,
      }),
    );
    mocks.runtime.mockImplementation(
      ({ evaluation }: { evaluation: { runtimeAuth: { id: string } } }) => evaluation.runtimeAuth,
    );
    const shared = await prepareWebSearchStatus(context(), {});
    const personal = await prepareWebSearchStatus(context(), {}, "personal");
    expect(shared.status?.route.kind).toBe("managed");
    expect(personal.status).toMatchObject({
      model: { runtime: "custom-harness" },
      route: { kind: "external", testable: false },
      testProvider: { id: "example" },
    });
  });

  it.each(["config", "missing", "secretRef"])(
    "projects %s credentials without disclosing them",
    async (source) => {
      const configured = source !== "missing";
      const value =
        source === "config"
          ? secret
          : source === "secretRef"
            ? { source: "file", provider: "vault", id: "/private/secret" }
            : undefined;
      mocks.configured.mockReturnValue(configured);
      mocks.options.mockReturnValue([provider({ getConfiguredCredentialValue: () => value })]);
      mocks.available.mockReturnValue(mocks.options());
      const result = await prepareWebSearchStatus(context(), {});
      expect(result.status).toMatchObject({
        provider: "example",
        route: { kind: "managed", provider: "example", testable: true },
        testProvider: { id: "example", label: "Example Search" },
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
      expect(JSON.stringify(result.status)).not.toContain(secret);
      expect(JSON.stringify(result.status)).not.toContain("/private/secret");
      if (!configured) {
        expect(result.status?.route.reason).toEqual(expect.stringContaining("credentials"));
      }
    },
  );

  it.each([false, true])(
    "keeps key-free setup explicit without using a sibling provider's credential (installed=%s)",
    async (installed) => {
      config = {};
      mocks.options.mockReturnValue([
        provider({ id: "keyfree", requiresCredential: false, credentialPath: "" }),
      ]);
      mocks.metadata.mockReturnValue({
        byPluginId: new Map(installed ? [["example", { id: "example" }]] : []),
      });
      mocks.available.mockReturnValue([]);
      mocks.selection.mockReturnValue("");
      const result = await prepareWebSearchStatus(context(), {});
      expect(result.status).toMatchObject({
        provider: null,
        route: { kind: "unavailable", testable: false },
        providers: [{ id: "keyfree", installed, available: false, credentialSource: "none" }],
      });
      expect(result.status?.testProvider).toBeUndefined();
      expect(result.status?.providers[0]?.credential).toBeUndefined();
    },
  );

  it("projects only the provider-owned configuration subtree", async () => {
    mocks.options.mockReturnValue([
      provider({ id: "free", configPath: null, credentialPath: "", requiresCredential: false }),
      provider({ id: "custom", configPath: ["customSearch"] }),
    ]);
    mocks.available.mockReturnValue([]);
    const result = await prepareWebSearchStatus(context(), {});
    expect(result.status?.providers.find((entry) => entry.id === "free")?.configPath).toEqual([]);
    expect(result.status?.providers.find((entry) => entry.id === "custom")?.configPath).toEqual([
      "plugins",
      "entries",
      "example",
      "config",
      "customSearch",
    ]);
  });

  it.each([false, true])(
    "does not advertise a probe when disabled by global or tool policy (global=%s)",
    async (globalEnabled) => {
      config = { tools: { web: { search: { enabled: globalEnabled, provider: "example" } } } };
      mocks.policy.mockReturnValue({ allowed: !globalEnabled });
      const result = await prepareWebSearchStatus(context(), {});
      expect(result.status?.route).toMatchObject({ kind: "disabled", testable: false });
      expect(result.status?.testProvider).toBeUndefined();
      expect(mocks.catalog).not.toHaveBeenCalled();
    },
  );
});
