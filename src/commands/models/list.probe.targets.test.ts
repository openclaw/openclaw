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

// mock-isolation: Probe planning uses fixture stores and never discovers operator credentials.
vi.mock("../../agents/auth-profiles.js", () => ({
  externalCliDiscoveryScoped: (params: Record<string, unknown> = {}) => ({
    mode: "scoped",
    ...params,
  }),
  ensureAuthProfileStoreAsync: async (agentDir?: string) =>
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
type ProbePlan = Awaited<ReturnType<typeof buildProbeTargets>>;
type ProbeTarget = ProbePlan["targets"][number];
function target(
  provider: string,
  model: string,
  source: ProbeTarget["source"] = "models.json",
  overrides: Partial<ProbeTarget> = {},
): ProbeTarget {
  return {
    provider,
    model: { provider, model },
    label: source,
    source,
    mode: "api_key",
    ...overrides,
  };
}

function catalogModel(
  provider: string,
  id: string,
  status?: ModelCatalogEntry["status"],
): ModelCatalogEntry {
  return { provider, id, name: id, ...(status ? { status } : {}) };
}

function expectTargets(result: ProbePlan, ...targets: ProbeTarget[]) {
  expect(result.results).toStrictEqual([]);
  expect(result.targets).toStrictEqual(targets);
}

function profileIssue(reasonCode: string, error: string) {
  const profileId = "anthropic:default";
  return {
    ...target("anthropic", "claude-sonnet-4-6", "profile", { profileId, label: profileId }),
    model: "anthropic/claude-sonnet-4-6",
    mode: "token",
    status: "unknown",
    reasonCode,
    error,
  };
}
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
  const entry: ModelProviderConfig = {
    baseUrl: "https://api.anthropic.com/v1",
    api: "anthropic-messages",
    models: [],
    apiKey,
    ...overrides,
  };
  return { models: { providers: { [provider]: entry } } };
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
      catalogModel("ollama", "retired", "deprecated"),
      catalogModel("ollama", "disabled", "disabled"),
      catalogModel("ollama", "first-live", "preview"),
      catalogModel("ollama", "second-live", "available"),
    ]);
    const result = await ollamaPlan();
    expect(result.results).toEqual([]);
    expect(loadModelCatalogMock).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true }));
    expect(result.targets).toEqual([
      target("ollama", "first-live", "models.json", { useRuntimeAuth: true }),
    ]);
  });

  it("preserves an explicit retired model and presents its local marker as provider configuration", async () => {
    emptyStore();
    loadModelCatalogMock.mockResolvedValueOnce([
      catalogModel("ollama", "llama3.2:latest", "deprecated"),
      catalogModel("ollama", "replacement"),
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

  it.each(["api_key", "token"] as const)(
    "reports unresolved_ref for %s profiles despite retained plaintext",
    async (type) => {
      const profileId = "anthropic:default";
      const refId = type === "api_key" ? "MISSING_ANTHROPIC_KEY" : "MISSING_ANTHROPIC_TOKEN";
      const ref = { source: "env" as const, provider: "default", id: refId };
      mockStore.profiles[profileId] =
        type === "api_key"
          ? { type, provider: "anthropic", key: "retained-plaintext", keyRef: ref }
          : { type, provider: "anthropic", token: "retained-plaintext", tokenRef: ref };
      resolveSecretRefStringMock.mockRejectedValueOnce(new Error("missing secret"));
      const result = await plan({ cfg: { auth: { order: { anthropic: [profileId] } } } });
      expect(result.targets).toStrictEqual([]);
      expect(result.results).toHaveLength(1);
      expectLegacyMissingCredentialsError(result.results[0], "unresolved_ref");
      expect(result.results[0]?.error).toContain(`env:default:${refId}`);
      expect(resolveSecretRefStringMock).toHaveBeenCalledWith(ref, expect.any(Object));
    },
  );

  it("adds direct credentials alongside an ineligible stored profile", async () => {
    const result = await withEnvAsync({ ANTHROPIC_API_KEY: "env-test" }, () =>
      plan({ cfg: providerConfig("test"), options: { includeDirectKeys: true } }),
    );
    expect(result.results).toStrictEqual([
      profileIssue(
        "invalid_expires",
        "Auth profile credentials are missing or expired.\n↳ Auth reason [invalid_expires]: token expires must be a positive Unix ms timestamp.",
      ),
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
      catalogModel("anthropic", "deprecated-model", "deprecated"),
      catalogModel("anthropic", "disabled-model", "disabled"),
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
    ["resolved SecretRef", true, false],
    ["unresolved SecretRef", true, true],
    ["normal-mode SecretRef", false, false],
  ] as const)(
    "preserves configured provider credential ownership for %s",
    async (_description, includeDirectKeys, rejectRef) => {
      emptyStore();
      const apiKey = {
        source: "env" as const,
        provider: "default",
        id: "CONFIGURED_ANTHROPIC_CREDENTIAL",
      };
      if (rejectRef) {
        resolveSecretRefStringMock.mockRejectedValueOnce(new Error("missing configured secret"));
      }
      const result = await withEnvAsync({ ANTHROPIC_API_KEY: "ambient-provider-credential" }, () =>
        configPlan(apiKey, includeDirectKeys),
      );
      expect(result.targets.some((entry) => entry.source === "env")).toBe(false);
      if (rejectRef) {
        expect(result.targets).toStrictEqual([]);
        expect(result.results).toEqual([
          expect.objectContaining({ source: "models.json", reasonCode: "unresolved_ref" }),
        ]);
      } else if (includeDirectKeys) {
        expect(result.results).toEqual([]);
        expect(result.targets).toEqual([
          expect.objectContaining({
            source: "models.json",
            label: "config",
            boundValue: "resolved-secret",
          }),
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
      profileIssue("excluded_by_auth_order", "Excluded by auth.order for this provider."),
    ]);
    expect(result.targets).toStrictEqual(
      [ref, "anthropic:other"].map((profileId) =>
        target("anthropic", "claude-sonnet-4-6", "profile", { profileId, label: profileId }),
      ),
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

  it.each(["byteplus", "byteplus-plan"])(
    "keeps alias model selection with profiles stored under %s",
    async (authProvider) => {
      const canonicalAuth = authProvider === "byteplus";
      const profileId = canonicalAuth ? "byteplus:plan" : "byteplus-plan:saved";
      mockStore = {
        version: 1,
        profiles: { [profileId]: createApiKeyCredential(authProvider, "byteplus-plan-key") },
        order: { [authProvider]: [profileId] },
      };
      resolveAuthProfileEligibilityMock.mockReturnValue({ eligible: true, reasonCode: "ok" });
      let cfg: OpenClawConfig = {};
      if (canonicalAuth) {
        loadModelCatalogMock.mockResolvedValueOnce([
          catalogModel("byteplus", "seed-2-0-mini"),
          catalogModel("byteplus-plan", "ark-code-latest"),
        ]);
        cfg = providerConfig(undefined, "byteplus-plan", {
          baseUrl: "https://ark.ap-southeast.bytepluses.com/api/coding/v3",
          api: "openai-completions",
        });
        cfg.auth = { order: { byteplus: [profileId] } };
      }
      const result = await plan({
        cfg,
        providers: ["byteplus-plan"],
        modelCandidates: canonicalAuth ? [] : ["byteplus-plan/ark-code-latest"],
      });
      expectTargets(
        result,
        target("byteplus-plan", "ark-code-latest", "profile", {
          profileId,
          label: profileId,
        }),
      );
    },
  );

  it("matches canonical providers against alias-valued catalog probe models", async () => {
    emptyStore();
    loadModelCatalogMock.mockResolvedValueOnce([catalogModel("z.ai", "glm-4.7")]);
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
    expectTargets(result, target("zai", "glm-4.7"));
  });

  it("prioritizes live Anthropic Haiku catalog entries over retired and slower probes", async () => {
    emptyStore();
    loadModelCatalogMock.mockResolvedValueOnce([
      catalogModel("anthropic", "claude-haiku-4-5-20261001", "deprecated"),
      catalogModel("anthropic", "claude-3-haiku-20240307"),
      catalogModel("anthropic", "claude-haiku-4-5"),
      catalogModel("anthropic", "claude-haiku-4-5-20251001"),
      catalogModel("anthropic", "claude-sonnet-4-6"),
    ]);
    const result = await withClearedAnthropicEnv(() =>
      plan({ cfg: providerConfig("sk-ant-test"), modelCandidates: [] }),
    );
    expectTargets(result, target("anthropic", "claude-haiku-4-5-20251001"));
  });

  it("uses workspace-scoped auth evidence when building env probe targets", async () => {
    emptyStore();
    loadModelCatalogMock.mockResolvedValue([catalogModel("workspace-cloud", "workspace-model")]);
    const input = { providers: ["workspace-cloud"], modelCandidates: [] };
    expect((await plan(input)).targets).toStrictEqual([]);
    expect((await plan({ ...input, workspaceDir: "/tmp/workspace" })).targets).toStrictEqual([
      target("workspace-cloud", "workspace-model", "env"),
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
      expectTargets(
        result,
        target("anthropic", "claude-sonnet-4-6", "profile", {
          label: "anthropic:coder",
          profileId: "anthropic:coder",
        }),
      );
    });
  });
});
