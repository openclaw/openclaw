import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginWebSearchProviderEntry } from "../../plugins/web-provider-types.js";
import type { GatewayRequestContext } from "./types.js";

const mocks = vi.hoisted(() => ({
  scope: vi.fn(),
  defaults: vi.fn(),
  options: vi.fn(),
  configured: vi.fn(),
  available: vi.fn(),
  selection: vi.fn(),
  metadata: vi.fn(),
  descriptors: vi.fn(),
  source: vi.fn(),
  auth: vi.fn(),
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
  resolveModelAuthAgentScope: mocks.scope,
  modelAuthAgentScopeError: vi.fn(),
}));
vi.mock("../../agents/model-selection.js", () => ({ resolveDefaultModelForAgent: mocks.defaults }));
vi.mock("../../flows/search-setup.js", () => ({ listSearchProviderOptions: mocks.options }));
vi.mock("../../web-search/runtime.js", () => ({
  isWebSearchProviderConfigured: mocks.configured,
  listConfiguredWebSearchProviders: mocks.available,
  resolveWebSearchProviderId: mocks.selection,
}));
vi.mock("../../plugins/management-service.js", () => ({
  resolveManagedPluginMetadata: mocks.metadata,
}));
vi.mock("../../plugins/credential-descriptors.js", () => ({
  resolvePluginCredentialDescriptors: mocks.descriptors,
}));
vi.mock("../../config/runtime-snapshot.js", () => ({
  getRuntimeConfigSourceSnapshot: mocks.source,
}));
vi.mock("../../agents/tools/model-config.helpers.js", () => ({
  hasAuthProfileForProvider: mocks.auth,
}));
vi.mock("../../agents/web-search-tool-policy.js", () => ({
  resolveWebSearchToolPolicy: mocks.policy,
}));
vi.mock("../server-model-catalog-auth.js", () => ({ readPreparedCatalog: mocks.catalog }));
vi.mock("../../agents/model-catalog-decisions.js", () => ({
  createModelCatalogDecisions: mocks.decisions,
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
  mocks.scope.mockReturnValue({ ok: true, agentId: "main", agentDir: "/synthetic/agent" });
  mocks.defaults.mockReturnValue({ provider: "custom", model: "model" });
  mocks.options.mockReturnValue([provider()]);
  mocks.available.mockReturnValue([provider()]);
  mocks.configured.mockReturnValue(true);
  mocks.selection.mockReturnValue("example");
  mocks.metadata.mockReturnValue({ byPluginId: new Map([["example", { id: "example" }]]) });
  mocks.descriptors.mockReturnValue([credential]);
  mocks.source.mockReturnValue(undefined);
  mocks.auth.mockReturnValue(false);
  mocks.policy.mockReturnValue({ allowed: true });
  withModelCatalog();
  mocks.native.mockReturnValue({ kind: "managed" });
  mocks.runtime.mockReturnValue({ id: "openclaw" });
  mocks.decisions.mockReturnValue({
    evaluateEntry: async () => ({}),
    evaluateNative: (_entry: unknown, host: unknown) => host,
  });
});
function withModelCatalog() {
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
}

describe("Search settings status projection", () => {
  it.each(["missing-catalog", "unknown-model"])(
    "keeps model routing unknown for %s while allowing an explicit service probe",
    async (scenario) => {
      if (scenario === "missing-catalog") {
        mocks.catalog.mockResolvedValue(undefined);
      }
      const result = await prepareWebSearchStatus(
        context(),
        scenario === "unknown-model" ? { modelProvider: "custom", modelId: "unknown" } : {},
      );
      expect(result.status).toMatchObject({
        model: { runtime: "unknown" },
        route: { kind: "unavailable", label: "Model search route is not ready", testable: false },
        testProvider: { id: "example" },
      });
    },
  );

  it("uses the authenticated requester's existing model account decision", async () => {
    mocks.decisions.mockImplementation(
      ({ requesterProfileId }: { requesterProfileId?: string }) => ({
        evaluateEntry: async () => ({
          runtimeAuth: { id: requesterProfileId === "personal" ? "codex" : "openclaw" },
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
      model: { runtime: "codex" },
      route: { kind: "external" },
    });
  });

  it("reports provider configuration and editing metadata without any credential value", async () => {
    const result = await prepareWebSearchStatus(context(), {});
    expect(result.status).toMatchObject({
      provider: "example",
      route: { kind: "managed", provider: "example", testable: true },
      testProvider: { id: "example", label: "Example Search" },
      providers: [
        {
          configured: true,
          installed: true,
          available: true,
          credentialSource: "config",
          credential,
          configPath: ["plugins", "entries", "example", "config", "webSearch"],
        },
      ],
    });
    expect(JSON.stringify(result.status)).not.toContain(secret);
  });

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
      mocks.policy.mockReturnValue({ allowed: false });
      const result = await prepareWebSearchStatus(context(), {});
      expect(result.status?.route).toMatchObject({ kind: "disabled", testable: false });
      expect(result.status?.testProvider).toBeUndefined();
      expect(mocks.catalog).not.toHaveBeenCalled();
    },
  );

  it.each([
    { provider: "openai", transport: "openai-responses" },
    { provider: "fixture-search", transport: "fixture-responses" },
  ])(
    "reports the $provider native owner without a vendor-specific label",
    async ({ provider: nativeProvider, transport }) => {
      withModelCatalog();
      mocks.native.mockReturnValue({
        kind: "native",
        provider: nativeProvider,
        transport,
      });
      const result = await prepareWebSearchStatus(context(), {
        modelProvider: "custom",
        modelId: "model",
      });
      expect(result.status).toMatchObject({
        model: { provider: "custom", id: "model", runtime: "openclaw" },
        route: {
          kind: "native",
          provider: nativeProvider,
          label: "Native web search",
          testable: false,
        },
      });
    },
  );

  it.each(["codex", "claude-cli", "custom-harness"])(
    "does not infer native search capability for the %s harness",
    async (runtime) => {
      withModelCatalog();
      mocks.runtime.mockReturnValue({ id: runtime });
      const result = await prepareWebSearchStatus(context(), {});
      expect(result.status).toMatchObject({
        model: { runtime },
        route: { kind: "external", testable: false },
        testProvider: { id: "example" },
      });
    },
  );

  it("retains missing credentials instead of equating configuration with provider health", async () => {
    mocks.configured.mockReturnValue(false);
    mocks.options.mockReturnValue([provider({ getConfiguredCredentialValue: () => undefined })]);
    mocks.available.mockReturnValue(mocks.options());
    const result = await prepareWebSearchStatus(context(), {});
    expect(result.status).toMatchObject({
      route: { kind: "managed", reason: expect.stringContaining("credentials") },
      providers: [{ configured: false, credentialSource: "missing" }],
    });
  });

  it("does not return credential reference contents", async () => {
    mocks.options.mockReturnValue([
      provider({
        getConfiguredCredentialValue: () => ({
          source: "file",
          provider: "vault",
          id: "/private/secret",
        }),
      }),
    ]);
    mocks.available.mockReturnValue(mocks.options());
    const result = await prepareWebSearchStatus(context(), {});
    expect(result.status?.providers[0]?.credentialSource).toBe("secretRef");
    expect(JSON.stringify(result.status)).not.toContain("/private/secret");
  });
});
