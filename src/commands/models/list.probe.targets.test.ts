// Model probe target tests cover selecting provider/model targets for probing.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import { createApiKeyCredential } from "../../agents/auth-profiles/credential-fixtures.test-support.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveConfigForRead } from "../../config/io.read-helpers.js";
import { setConfigResolutionFacts } from "../../config/resolution-facts.js";
import type { ModelProviderConfig } from "../../config/types.models.js";
import { withEnvAsync } from "../../test-utils/env.js";

let mockStore: AuthProfileStore;
let mockAgentStore: AuthProfileStore | undefined;
const loadModelCatalogMock = vi.fn<() => Promise<ModelCatalogEntry[]>>(async () => []);

const resolveAuthProfileEligibilityMock = vi.fn<
  () => { eligible: boolean; reasonCode: "invalid_expires" | "ok" }
>(() => ({
  eligible: false,
  reasonCode: "invalid_expires",
}));
const resolveSecretRefStringMock = vi.fn(async () => "resolved-secret");
type ProviderAuthInput = { cfg: OpenClawConfig; provider: string };

vi.mock("../../agents/prepared-model-catalog.js", () => ({
  readPreparedModelCatalog: loadModelCatalogMock,
}));
vi.mock("../../agents/model-auth.js", () => ({
  hasSyntheticLocalProviderAuthConfig: ({ cfg, provider }: ProviderAuthInput) => {
    const configured = cfg.models?.providers?.[provider];
    return (
      provider === "ollama" &&
      configured?.api === "ollama" &&
      configured.apiKey === undefined &&
      configured.baseUrl === "http://127.0.0.1:11434"
    );
  },
  hasUsableCustomProviderApiKey: (cfg: OpenClawConfig, provider: string) => {
    const raw = cfg.models?.providers?.[provider]?.apiKey;
    if (provider === "ollama") {
      return raw === "ollama-local";
    }
    return typeof raw === "string" && raw.trim().length > 0 && raw !== "ollama-local";
  },
  resolveEnvApiKey: (
    provider: string,
    _env?: NodeJS.ProcessEnv,
    options?: { workspaceDir?: string },
  ) => {
    if (provider === "workspace-cloud") {
      return options?.workspaceDir === "/tmp/workspace"
        ? {
            source: "workspace cloud credentials",
            apiKey: "workspace-cloud-local-credentials",
          }
        : null;
    }
    const keys =
      provider === "anthropic"
        ? ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"]
        : provider === "zai"
          ? ["ZAI_API_KEY", "Z_AI_API_KEY"]
          : [];
    const source = keys.find((key) => process.env[key]?.trim());
    return source
      ? {
          source: `env: ${source}`,
          ...Object.fromEntries([["apiKey", process.env[source]]]),
        }
      : null;
  },
  resolveProviderEntryApiKeyProfileReference: (params: {
    cfg: OpenClawConfig;
    provider: string;
    store: AuthProfileStore;
  }) => {
    const raw = params.cfg.models?.providers?.[params.provider]?.apiKey;
    if (params.provider === "ollama") {
      return { kind: raw === "ollama-local" ? "marker" : "none" };
    }
    if (typeof raw !== "string") {
      return { kind: "none" };
    }
    const profile = params.store.profiles[raw];
    return profile
      ? { kind: "profile", profileId: raw, profile, mode: profile.type }
      : { kind: "literal", apiKey: raw, source: "models.json" };
  },
  resolveProviderEntryApiKeyBinding: async () => ({ kind: "profile-unresolved" }),
  resolveUsableCustomProviderApiKey: ({ cfg, provider }: ProviderAuthInput) =>
    provider === "ollama" && cfg.models?.providers?.[provider]?.apiKey === "ollama-local"
      ? { apiKey: "ollama-local", source: "models.json (local marker)" }
      : null,
}));
vi.mock("../../agents/provider-auth-aliases.js", () => ({
  resolveProviderIdForAuth: (provider: string) =>
    provider === "byteplus-plan" ? "byteplus" : provider,
}));
vi.mock("../../agents/model-selection.js", () => {
  const normalizeProviderId = (value: string) =>
    value.trim().toLowerCase() === "z.ai" || value.trim().toLowerCase() === "z-ai"
      ? "zai"
      : value.trim().toLowerCase();
  return {
    normalizeProviderId,
    findNormalizedProviderValue: (record: Record<string, unknown> | undefined, provider: string) =>
      Object.entries(record ?? {}).find(([key]) => normalizeProviderId(key) === provider)?.[1],
    parseModelRef: (raw: string, defaultProvider: string) => {
      const [provider, ...modelParts] = raw.includes("/") ? raw.split("/") : [defaultProvider, raw];
      const model = modelParts.join("/");
      return provider && model ? { provider: normalizeProviderId(provider), model } : null;
    },
  };
});
vi.mock("../../secrets/resolve.js", () => ({
  resolveSecretRefString: resolveSecretRefStringMock,
}));
vi.mock("../status-all/format.js", () => ({
  redactStatusSecrets: (value: string) => value,
}));
vi.mock("./shared.js", () => ({
  DEFAULT_PROVIDER: "openai",
  formatMs: (ms: number) => `${ms}ms`,
}));

vi.mock("../../agents/auth-profiles.js", () => ({
  externalCliDiscoveryScoped: (params: Record<string, unknown> = {}) => ({
    mode: "scoped",
    ...params,
  }),
  ensureAuthProfileStore: (agentDir?: string) =>
    agentDir === "/tmp/coder-agent" && mockAgentStore ? mockAgentStore : mockStore,
  listProfilesForProvider: (store: AuthProfileStore, provider: string) =>
    Object.entries(store.profiles)
      .filter(
        ([, profile]) =>
          typeof profile.provider === "string" && profile.provider.toLowerCase() === provider,
      )
      .map(([profileId]) => profileId),
  resolveAuthProfileDisplayLabel: ({ profileId }: { profileId: string }) => profileId,
  resolveAuthProfileEligibility: resolveAuthProfileEligibilityMock,
}));

const { buildProbeTargets } = await import("./list.probe.js");

type ProbeParams = Parameters<typeof buildProbeTargets>[0];
function plan(
  overrides: Omit<Partial<ProbeParams>, "options"> & {
    options?: Partial<ProbeParams["options"]>;
  } = {},
) {
  return buildProbeTargets({
    cfg: {},
    providers: ["anthropic"],
    modelCandidates: ["anthropic/claude-sonnet-4-6"],
    ...overrides,
    options: { timeoutMs: 5_000, concurrency: 1, maxTokens: 16, ...overrides.options },
  });
}

function providerConfig(
  apiKey: ModelProviderConfig["apiKey"],
  provider = "anthropic",
  overrides: Partial<ModelProviderConfig> = {},
): OpenClawConfig {
  return {
    models: {
      providers: {
        [provider]: {
          baseUrl: "https://api.anthropic.com/v1",
          api: "anthropic-messages",
          models: [],
          apiKey,
          ...overrides,
        },
      },
    },
  };
}

function emptyStore() {
  mockStore = { version: 1, profiles: {}, order: {} };
}

function ollamaPlan(apiKey?: string) {
  return plan({
    cfg: providerConfig(apiKey, "ollama", { baseUrl: "http://127.0.0.1:11434", api: "ollama" }),
    providers: ["ollama"],
    modelCandidates: apiKey ? ["ollama/llama3.2:latest"] : [],
    options: { includeDirectKeys: true, maxTokens: 8 },
  });
}

function withClearedAnthropicEnv<T>(fn: () => Promise<T>): Promise<T> {
  return withEnvAsync({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_OAUTH_TOKEN: undefined }, fn);
}

async function configPlan(apiKey: ModelProviderConfig["apiKey"], includeDirectKeys = false) {
  const cfg = providerConfig(apiKey);
  setConfigResolutionFacts(cfg, new Set());
  return plan({ cfg, options: { includeDirectKeys } });
}

function expectLegacyMissingCredentialsError(
  result: { reasonCode?: string; error?: string } | undefined,
  reasonCode: string,
) {
  expect(result?.reasonCode).toBe(reasonCode);
  expect(result?.error?.split("\n")[0]).toBe("Auth profile credentials are missing or expired.");
  expect(result?.error).toContain(`[${reasonCode}]`);
}

describe("buildProbeTargets", () => {
  beforeEach(() => {
    mockStore = {
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          tokenRef: { source: "env", provider: "default", id: "ANTHROPIC_TOKEN" },
          expires: 0,
        },
      },
      order: { anthropic: ["anthropic:default"] },
    };
    mockAgentStore = undefined;
    loadModelCatalogMock.mockReset().mockResolvedValue([]);
    resolveAuthProfileEligibilityMock.mockClear();
    resolveSecretRefStringMock.mockReset().mockResolvedValue("resolved-secret");
    resolveAuthProfileEligibilityMock.mockReturnValue({
      eligible: false,
      reasonCode: "invalid_expires",
    });
  });

  it("uses runtime auth and the first eligible catalog model for automatic local probes", async () => {
    emptyStore();
    loadModelCatalogMock.mockResolvedValueOnce([
      { provider: "ollama", id: "retired", name: "Retired", status: "deprecated" },
      { provider: "ollama", id: "disabled", name: "Disabled", status: "disabled" },
      { provider: "ollama", id: "first-live", name: "First", status: "preview" },
      { provider: "ollama", id: "second-live", name: "Second", status: "available" },
    ]);
    const result = await ollamaPlan();
    expect(result.results).toEqual([]);
    expect(loadModelCatalogMock).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true }));
    expect(result.targets).toEqual([
      {
        provider: "ollama",
        model: { provider: "ollama", model: "first-live" },
        label: "models.json",
        source: "models.json",
        mode: "api_key",
        useRuntimeAuth: true,
      },
    ]);
  });

  it("preserves an explicit retired model and presents its local marker as provider configuration", async () => {
    emptyStore();
    loadModelCatalogMock.mockResolvedValueOnce([
      { provider: "ollama", id: "llama3.2:latest", name: "Retired", status: "deprecated" },
      { provider: "ollama", id: "replacement", name: "Replacement" },
    ]);
    const result = await ollamaPlan("ollama-local");
    expect(result.results).toEqual([]);
    expect(result.targets).toEqual([
      expect.objectContaining({
        provider: "ollama",
        model: { provider: "ollama", model: "llama3.2:latest" },
        label: "provider",
        source: "models.json",
        boundValue: "ollama-local",
        useRuntimeAuth: true,
      }),
    ]);
  });

  it("reports unresolved_ref for token profiles despite retained plaintext", async () => {
    const profileId = "anthropic:default";
    const ref = { source: "env" as const, provider: "default", id: "MISSING_ANTHROPIC_TOKEN" };
    mockStore.profiles[profileId] = {
      type: "token",
      provider: "anthropic",
      token: "retained-plaintext",
      tokenRef: ref,
    };
    resolveSecretRefStringMock.mockRejectedValueOnce(new Error("missing secret"));
    const result = await plan({ cfg: { auth: { order: { anthropic: [profileId] } } } });
    expect(result.targets).toStrictEqual([]);
    expect(result.results).toHaveLength(1);
    expectLegacyMissingCredentialsError(result.results[0], "unresolved_ref");
    expect(result.results[0]?.error).toContain(`env:default:${ref.id}`);
    expect(resolveSecretRefStringMock).toHaveBeenCalledWith(ref, expect.any(Object));
  });

  it("adds direct credentials alongside an ineligible stored profile", async () => {
    const result = await withEnvAsync({ ANTHROPIC_API_KEY: "env-test" }, () =>
      plan({ cfg: providerConfig("test"), options: { includeDirectKeys: true } }),
    );
    expect(result.results).toStrictEqual([
      {
        error:
          "Auth profile credentials are missing or expired.\n↳ Auth reason [invalid_expires]: token expires must be a positive Unix ms timestamp.",
        label: "anthropic:default",
        mode: "token",
        model: "anthropic/claude-sonnet-4-6",
        profileId: "anthropic:default",
        provider: "anthropic",
        reasonCode: "invalid_expires",
        source: "profile",
        status: "unknown",
      },
    ]);
    expect(result.targets).toEqual([
      expect.objectContaining({ label: "config", source: "models.json", boundValue: "test" }),
      expect.objectContaining({
        label: "env: ANTHROPIC_API_KEY",
        source: "env",
        boundValue: "env-test",
      }),
    ]);
  });

  it("omits credential values from no_model results when all catalog models are retired", async () => {
    emptyStore();
    loadModelCatalogMock.mockResolvedValueOnce([
      { provider: "anthropic", id: "deprecated-model", name: "Deprecated", status: "deprecated" },
      { provider: "anthropic", id: "disabled-model", name: "Disabled", status: "disabled" },
    ]);
    const result = await plan({
      cfg: providerConfig("test"),
      modelCandidates: [],
      options: { includeDirectKeys: true },
    });
    expect(result.targets).toEqual([]);
    expect(result.results).toContainEqual(
      expect.objectContaining({
        label: "config",
        source: "models.json",
        status: "no_model",
        reasonCode: "no_model",
      }),
    );
    expect(result.results[0]).not.toHaveProperty("boundValue");
  });

  it.each([
    ["unresolved SecretRef", true],
    ["normal-mode SecretRef", false],
  ] as const)(
    "preserves configured provider credential ownership for %s",
    async (_description, includeDirectKeys) => {
      emptyStore();
      const apiKey = {
        source: "env" as const,
        provider: "default",
        id: "CONFIGURED_ANTHROPIC_CREDENTIAL",
      };
      if (includeDirectKeys) {
        resolveSecretRefStringMock.mockRejectedValueOnce(new Error("missing configured secret"));
      }
      const result = await withEnvAsync({ ANTHROPIC_API_KEY: "ambient-provider-credential" }, () =>
        configPlan(apiKey, includeDirectKeys),
      );
      expect(result.targets.some((target) => target.source === "env")).toBe(false);
      if (includeDirectKeys) {
        expect(result.targets).toStrictEqual([]);
        expect(result.results).toEqual([
          expect.objectContaining({ source: "models.json", reasonCode: "unresolved_ref" }),
        ]);
      }
    },
  );

  it.each([
    ["missing with authored provider spelling", "$MISSING", undefined, null, "AnThRoPiC"],
    ["substituted template-looking literal", "${SOURCE}", "${OTHER}", "${OTHER}", "anthropic"],
  ] as const)(
    "preserves authored credential provenance: %s",
    async (_name, authored, sourceValue, expected, providerKey) => {
      emptyStore();
      resolveSecretRefStringMock.mockRejectedValue(new Error("missing secret"));
      const read = resolveConfigForRead(
        providerConfig(authored, providerKey),
        sourceValue === undefined ? {} : { SOURCE: sourceValue },
      );
      const cfg = read.resolvedConfigRaw as OpenClawConfig;
      setConfigResolutionFacts(cfg, read.resolutionFacts);
      const result = await withClearedAnthropicEnv(() =>
        plan({ cfg, options: { includeDirectKeys: true } }),
      );
      if (expected === null) {
        expect(result.targets).toEqual([]);
        expect(result.results[0]).toMatchObject({ label: "config", reasonCode: "unresolved_ref" });
      } else {
        expect(result.results).toEqual([]);
        expect(result.targets[0]).toMatchObject({ label: "config", boundValue: expected });
      }
    },
  );

  it("only exempts the config-bound profile from auth.order exclusions", async () => {
    const ref = "anthropic:saved";
    mockStore.profiles[ref] = createApiKeyCredential("anthropic", "placeholder");
    mockStore.profiles["anthropic:other"] = createApiKeyCredential("anthropic", "placeholder");
    mockStore.order = { anthropic: ["anthropic:other"] };
    resolveAuthProfileEligibilityMock.mockReturnValue({ eligible: true, reasonCode: "ok" });
    const result = await plan({ cfg: providerConfig(ref), options: { includeDirectKeys: true } });
    expect(result.results).toStrictEqual([
      {
        error: "Excluded by auth.order for this provider.",
        label: "anthropic:default",
        mode: "token",
        model: "anthropic/claude-sonnet-4-6",
        profileId: "anthropic:default",
        provider: "anthropic",
        reasonCode: "excluded_by_auth_order",
        source: "profile",
        status: "unknown",
      },
    ]);
    expect(result.targets).toStrictEqual(
      [ref, "anthropic:other"].map((profileId) => ({
        provider: "anthropic",
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
        profileId,
        label: profileId,
        source: "profile",
        mode: "api_key",
      })),
    );
  });

  it("probes an environment credential with the configured token auth mode", async () => {
    emptyStore();
    const result = await withEnvAsync({ ZAI_API_KEY: "env-zai" }, () =>
      plan({
        cfg: providerConfig(undefined, "zai", {
          baseUrl: "https://api.z.ai/v1",
          api: "openai-responses",
          auth: "token",
        }),
        providers: ["zai"],
        modelCandidates: ["zai/glm-4.7"],
        options: { includeDirectKeys: true },
      }),
    );
    expect(result.targets).toContainEqual(
      expect.objectContaining({ source: "env", label: "env: ZAI_API_KEY", mode: "token" }),
    );
  });

  it("keeps alias model selection while resolving profiles from the auth provider", async () => {
    mockStore = {
      version: 1,
      profiles: { "byteplus:plan": createApiKeyCredential("byteplus", "byteplus-plan-key") },
      order: { byteplus: ["byteplus:plan"] },
    };
    resolveAuthProfileEligibilityMock.mockReturnValue({ eligible: true, reasonCode: "ok" });
    loadModelCatalogMock.mockResolvedValueOnce([
      { provider: "byteplus", id: "seed-2-0-mini", name: "BytePlus Standard" },
      { provider: "byteplus-plan", id: "ark-code-latest", name: "BytePlus Plan" },
    ]);
    const cfg = providerConfig(undefined, "byteplus-plan", {
      baseUrl: "https://ark.ap-southeast.bytepluses.com/api/coding/v3",
      api: "openai-completions",
    });
    cfg.auth = { order: { byteplus: ["byteplus:plan"] } };
    const result = await plan({ cfg, providers: ["byteplus-plan"], modelCandidates: [] });
    expect(result.results).toStrictEqual([]);
    expect(result.targets).toStrictEqual([
      {
        label: "byteplus:plan",
        mode: "api_key",
        model: { provider: "byteplus-plan", model: "ark-code-latest" },
        profileId: "byteplus:plan",
        provider: "byteplus-plan",
        source: "profile",
      },
    ]);
  });

  it("keeps profiles stored under the requested provider alias", async () => {
    mockStore = {
      version: 1,
      profiles: {
        "byteplus-plan:saved": createApiKeyCredential("byteplus-plan", "byteplus-plan-key"),
      },
      order: { "byteplus-plan": ["byteplus-plan:saved"] },
    };
    resolveAuthProfileEligibilityMock.mockReturnValue({ eligible: true, reasonCode: "ok" });
    const result = await plan({
      providers: ["byteplus-plan"],
      modelCandidates: ["byteplus-plan/ark-code-latest"],
    });
    expect(result.results).toStrictEqual([]);
    expect(result.targets).toContainEqual(
      expect.objectContaining({
        provider: "byteplus-plan",
        profileId: "byteplus-plan:saved",
        source: "profile",
      }),
    );
  });

  it("matches canonical providers against alias-valued catalog probe models", async () => {
    emptyStore();
    loadModelCatalogMock.mockResolvedValueOnce([
      { provider: "z.ai", id: "glm-4.7", name: "GLM-4.7" },
    ]);
    const result = await withEnvAsync({ ZAI_API_KEY: undefined, Z_AI_API_KEY: undefined }, () =>
      plan({
        cfg: providerConfig("sk-zai-test", "zai", {
          baseUrl: "https://api.z.ai/v1",
          api: "openai-responses",
        }),
        providers: ["zai"],
        modelCandidates: [],
      }),
    );
    expect(result.results).toStrictEqual([]);
    expect(result.targets).toStrictEqual([
      {
        label: "models.json",
        mode: "api_key",
        model: { provider: "zai", model: "glm-4.7" },
        provider: "zai",
        source: "models.json",
      },
    ]);
  });

  it("prioritizes live Anthropic Haiku catalog entries over retired and slower probes", async () => {
    emptyStore();
    loadModelCatalogMock.mockResolvedValueOnce([
      {
        provider: "anthropic",
        id: "claude-haiku-4-5-20261001",
        name: "Retired Haiku",
        status: "deprecated",
      },
      { provider: "anthropic", id: "claude-3-haiku-20240307", name: "Claude Haiku 3" },
      { provider: "anthropic", id: "claude-haiku-4-5", name: "Haiku alias" },
      { provider: "anthropic", id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
      { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    ]);
    const result = await withClearedAnthropicEnv(() =>
      plan({ cfg: providerConfig("sk-ant-test"), modelCandidates: [] }),
    );
    expect(result.results).toStrictEqual([]);
    expect(result.targets).toStrictEqual([
      {
        label: "models.json",
        mode: "api_key",
        model: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
        provider: "anthropic",
        source: "models.json",
      },
    ]);
  });

  it("uses workspace-scoped auth evidence when building env probe targets", async () => {
    emptyStore();
    loadModelCatalogMock.mockResolvedValue([
      { provider: "workspace-cloud", id: "workspace-model", name: "Workspace Model" },
    ]);
    const input = { providers: ["workspace-cloud"], modelCandidates: [] };
    expect((await plan(input)).targets).toStrictEqual([]);
    expect((await plan({ ...input, workspaceDir: "/tmp/workspace" })).targets).toStrictEqual([
      {
        label: "env",
        mode: "api_key",
        model: { provider: "workspace-cloud", model: "workspace-model" },
        provider: "workspace-cloud",
        source: "env",
      },
    ]);
  });

  it("uses the requested agent auth store when building profile probe targets", async () => {
    emptyStore();
    mockAgentStore = {
      version: 1,
      profiles: { "anthropic:coder": createApiKeyCredential("anthropic", "sk-ant-coder-profile") },
      order: {},
    };
    await withClearedAnthropicEnv(async () => {
      expect((await plan()).targets).toStrictEqual([]);
      const result = await plan({ agentDir: "/tmp/coder-agent" });
      expect(result.results).toStrictEqual([]);
      expect(result.targets).toStrictEqual([
        {
          label: "anthropic:coder",
          mode: "api_key",
          model: { provider: "anthropic", model: "claude-sonnet-4-6" },
          profileId: "anthropic:coder",
          provider: "anthropic",
          source: "profile",
        },
      ]);
    });
  });
});
