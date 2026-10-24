import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "../../../agents/auth-profiles/credential-fixtures.test-support.js";
import * as authProfileStore from "../../../agents/auth-profiles/store-runtime.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { resolveAgentModelPrimaryValue } from "../../../config/model-input.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../../../config/types.models.js";
import * as fetchGuard from "../../../infra/net/fetch-guard.js";
import { ExitError } from "../../../runtime.js";
import { withTempDir } from "../../../test-utils/temp-dir.js";
import * as apiProviderAuthChoices from "../../auth-choice.apply.api-providers.js";
import { commitNonInteractiveOnboardConfig } from "../config-write.js";
import { registerCustomCatalogImportTests } from "./auth-choice.catalog.test-support.js";
import { applyNonInteractiveAuthChoice } from "./auth-choice.js";

const writeWizardConfigFile = vi.hoisted(() =>
  vi.fn(async (config: OpenClawConfig) => ({ path: "/tmp/openclaw.json", nextConfig: config })),
);
vi.mock("../../../wizard/setup.shared.js", () => ({ writeWizardConfigFile }));

const formatAuthChoiceChoicesForCli = vi.hoisted(() =>
  vi.fn(() => "custom-api-key|skip|demo-provider-api-key"),
);
// mock-isolation: The fixed choice list avoids installed-provider discovery in dispatch tests.
vi.mock("../../auth-choice-options.js", () => ({ formatAuthChoiceChoicesForCli }));

const applyNonInteractivePluginProviderChoice = vi.hoisted(() =>
  vi.fn<typeof import("./auth-choice.plugin-providers.js").applyNonInteractivePluginProviderChoice>(
    async () => undefined,
  ),
);
// mock-isolation: Capture provider dispatch without loading or installing real providers.
vi.mock("./auth-choice.plugin-providers.js", () => ({ applyNonInteractivePluginProviderChoice }));

const resolveNonInteractiveApiKey = vi.hoisted(() => vi.fn());
// mock-isolation: Tests provide synthetic credential resolution without reading host secrets.
vi.mock("../api-keys.js", () => ({ resolveNonInteractiveApiKey }));

const resolveManifestDeprecatedProviderAuthChoice = vi.hoisted(() =>
  vi.fn<
    typeof import("../../../plugins/provider-auth-choices.js").resolveManifestDeprecatedProviderAuthChoice
  >(() => undefined),
);
const resolveManifestProviderAuthChoices = vi.hoisted(() => vi.fn(() => []));
vi.mock("../../../plugins/provider-auth-choices.js", () => ({
  resolveManifestDeprecatedProviderAuthChoice,
  resolveManifestProviderAuthChoices,
}));
const resolveDeprecatedProviderInstallCatalogEntry = vi.hoisted(() => vi.fn(() => undefined));
vi.mock("../../../plugins/provider-install-catalog.js", () => ({
  resolveDeprecatedProviderInstallCatalogEntry,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(authProfileStore, "loadAuthProfileStoreWithoutExternalProfilesAsync").mockResolvedValue(
    createAuthProfileStoreFixture({}),
  );
  runtime = createRuntime();
  nextConfig = { agents: { defaults: {} } };
  applyNonInteractivePluginProviderChoice.mockReset();
  applyNonInteractivePluginProviderChoice.mockResolvedValue(undefined);
  resolveNonInteractiveApiKey.mockReset();
  resolveManifestDeprecatedProviderAuthChoice.mockReset();
  resolveManifestDeprecatedProviderAuthChoice.mockReturnValue(undefined);
  resolveManifestProviderAuthChoices.mockReset();
  resolveManifestProviderAuthChoices.mockReturnValue([]);
  resolveDeprecatedProviderInstallCatalogEntry.mockReset();
  resolveDeprecatedProviderInstallCatalogEntry.mockReturnValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const azureBaseUrl = "https://fixture.openai.azure.com/openai/v1";

function createAzureCatalogConfig() {
  vi.stubEnv("AZURE_DISCOVERY_TEST_KEY", "fixture-azure-key");
  const model: ModelDefinitionConfig = {
    ...authoredModel,
    id: "chat-prod",
    name: "Production chat",
    maxTokens: 8192,
    input: ["text", "image"],
    compat: { supportsStore: true, supportsDeveloperRole: false },
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
  };
  const apiKey = { source: "env", provider: "default", id: "AZURE_DISCOVERY_TEST_KEY" } as const;
  const config: OpenClawConfig = {
    models: {
      providers: {
        local: { baseUrl: azureBaseUrl, api: "azure-openai-responses", apiKey, models: [model] },
      },
    },
    gateway: { port: 19_991, bind: "loopback" },
  };
  return { config, model };
}

function createRuntime() {
  return { error: vi.fn(), exit: vi.fn(), log: vi.fn() };
}

const target = { agentId: "main", agentDir: "/tmp/main-agent", workspaceDir: "/tmp/workspace" };

let runtime: ReturnType<typeof createRuntime>;
let nextConfig: OpenClawConfig;
type ChoiceParams = Parameters<typeof applyNonInteractiveAuthChoice>[0];

function applyChoice(params: Partial<ChoiceParams>) {
  const config = params.nextConfig ?? nextConfig;
  return applyNonInteractiveAuthChoice({
    nextConfig: config,
    baseConfig: config,
    authChoice: "custom-api-key",
    opts: {},
    runtime,
    target,
    ...params,
  });
}

const customBaseUrl = "https://models.custom.local/v1";
function applyCustomChoice(opts: ChoiceParams["opts"] = {}, config = nextConfig) {
  return applyChoice({ nextConfig: config, opts: { customBaseUrl, ...opts } });
}

function localConfig(provider: Partial<ModelProviderConfig> = {}, id = "local"): OpenClawConfig {
  return { models: { providers: { [id]: { baseUrl: customBaseUrl, models: [], ...provider } } } };
}

const authoredModel: ModelDefinitionConfig = {
  id: "local-large",
  name: "Authored",
  contextWindow: 65_536,
  maxTokens: 2048,
  reasoning: true,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
};

function applyManual(opts: ChoiceParams["opts"] = {}, config = nextConfig) {
  return applyCustomChoice(
    { customModelId: "local-large", secretInputMode: "ref", ...opts },
    config,
  );
}

function customProvider(config: OpenClawConfig | null, id = "custom-models-custom-local") {
  return config?.models?.providers?.[id];
}

function forbidDiscovery() {
  return vi
    .spyOn(fetchGuard, "fetchWithSsrFGuard")
    .mockRejectedValue(new Error("Unexpected discovery request"));
}

function expectCleanRuntime() {
  expect(runtime.error).not.toHaveBeenCalled();
  expect(runtime.exit).not.toHaveBeenCalled();
}

function expectDiscovered(config: OpenClawConfig | null, apiKey: ModelProviderConfig["apiKey"]) {
  expect(customProvider(config, "local")?.models).toEqual([
    expect.objectContaining({ id: "discovered-chat" }),
  ]);
  expect(customProvider(config, "local")?.apiKey).toEqual(apiKey);
  expect(runtime.error).not.toHaveBeenCalled();
}

function expectSecretRejection(key: string, ...hints: string[]) {
  expect(runtime.exit).toHaveBeenCalledWith(1);
  const error = runtime.error.mock.calls.map(([message]) => String(message)).join("\n");
  for (const hint of ["--secret-input-mode ref", ...hints]) {
    expect(error).toContain(hint);
  }
  expect(error).not.toContain(key);
}

function mockDiscovery(response: Response, finalUrl = `${customBaseUrl}/models`) {
  return vi.spyOn(fetchGuard, "fetchWithSsrFGuard").mockResolvedValue({
    response,
    finalUrl,
    release: async () => {},
  });
}

function mockAuthenticatedDiscovery(key?: string) {
  return vi.spyOn(fetchGuard, "fetchWithSsrFGuard").mockImplementation(async (input) => ({
    response:
      new Headers(input.init?.headers).get("Authorization") === (key ? `Bearer ${key}` : null)
        ? Response.json({ data: [{ id: "discovered-chat" }] })
        : new Response(null, { status: 401 }),
    finalUrl: input.url,
    release: async () => {},
  }));
}

function resolveKey(source: "env" | "flag" | "profile", key: string, envVarName?: string) {
  resolveNonInteractiveApiKey.mockResolvedValueOnce({ source, key, envVarName });
}

async function pluginCredentialConverter() {
  applyNonInteractivePluginProviderChoice.mockResolvedValueOnce(nextConfig);
  await applyChoice({ authChoice: "demo-provider-api-key", opts: { secretInputMode: "ref" } });
  const params = applyNonInteractivePluginProviderChoice.mock.calls.at(-1)?.[0];
  expect(params).toBeDefined();
  return params!.toApiKeyCredential;
}

function expectModelSelection(config: OpenClawConfig | null, primary: string, refs: string[]) {
  expect(resolveAgentModelPrimaryValue(config?.agents?.defaults?.model)).toBe(primary);
  expect(config?.agents?.defaults?.models).toMatchObject(
    Object.fromEntries(refs.map((ref) => [ref, {}])),
  );
}

describe("applyNonInteractiveAuthChoice", () => {
  it("rejects an unknown auth choice and lists the valid choices", async () => {
    const message =
      'Unknown --auth-choice "definitely-not-a-provider". Valid choices: custom-api-key, skip, demo-provider-api-key.';

    const result = await applyChoice({
      nextConfig,
      authChoice: "definitely-not-a-provider",
      opts: { json: true },
    });

    expect(result).toBeNull();
    expect(runtime.error).toHaveBeenCalledExactlyOnceWith(message);
    expect(runtime.log).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify(
        { ok: false, error: { type: "cli_error", message }, phase: "options", message },
        null,
        2,
      ),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it.each(["demo-provider-api-key", "apiKey"])(
    "dispatches %s from the selected agent workspace",
    async (authChoice) => {
      const resolvedConfig = {
        auth: { profiles: { "demo-provider:default": { mode: "api_key" } } },
      };
      applyNonInteractivePluginProviderChoice.mockResolvedValueOnce(resolvedConfig as never);
      if (authChoice === "apiKey") {
        vi.spyOn(
          apiProviderAuthChoices,
          "normalizeApiKeyTokenProviderAuthChoice",
        ).mockImplementation((params) =>
          params.workspaceDir === target.workspaceDir ? "demo-provider-api-key" : params.authChoice,
        );
      }
      const result = await applyChoice({
        authChoice,
        opts: authChoice === "apiKey" ? { tokenProvider: "demo-provider" } : {},
      });
      expect(result).toBe(resolvedConfig);
      expect(applyNonInteractivePluginProviderChoice).toHaveBeenCalledWith(
        expect.objectContaining({ target }),
      );
      expectCleanRuntime();
    },
  );

  it.each([
    [
      "legacy\u001b[31mchoice",
      "modern\nchoice",
      true,
      '"legacy\\u001b[31mchoice" is no longer supported. Use --auth-choice "modern\\nchoice" instead.',
    ],
    [
      "modelstudio-api-key",
      "qwen-api-key",
      false,
      '"modelstudio-api-key" is no longer supported. Use --auth-choice "qwen-api-key" instead.',
    ],
  ] as const)("guides deprecated choice %j", async (authChoice, choiceId, manifest, message) => {
    if (manifest) {
      resolveManifestDeprecatedProviderAuthChoice.mockReturnValueOnce({ choiceId } as never);
    } else {
      resolveDeprecatedProviderInstallCatalogEntry.mockReturnValueOnce({ choiceId } as never);
    }
    const result = await applyChoice({ authChoice });
    expect(result).toBeNull();
    expect(runtime.error).toHaveBeenCalledWith(message);
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(applyNonInteractivePluginProviderChoice).not.toHaveBeenCalled();
  });

  it.each(["openai", "openai-responses"] as const)(
    "imports discovered %s models and keeps authored metadata",
    async (compatibility) => {
      const request = mockDiscovery(
        Response.json({
          data: [
            { id: " local-large " },
            { id: "local-small" },
            { id: "local-large" },
            { id: " " },
            { id: 7 },
          ],
        }),
      );
      resolveKey("env", "fixture-discovery-key", "CUSTOM_API_KEY");
      const authored = authoredModel;
      const result = await applyCustomChoice(
        { customProviderId: "local", customCompatibility: compatibility },
        localConfig({ models: [authored] }),
      );
      expect(customProvider(result, "local")?.models).toEqual([
        authored,
        expect.objectContaining({ id: "local-small" }),
      ]);
      expectModelSelection(result, "local/local-large", ["local/local-large", "local/local-small"]);
      expect(request).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          url: "https://models.custom.local/v1/models",
          init: { headers: { Authorization: "Bearer fixture-discovery-key" } },
        }),
      );
    },
  );

  it.each([
    "inline",
    "environment marker",
    "environment SecretRef",
    "file SecretRef",
    "shared profile",
    "incompatible profile",
    "same-provider profile",
  ])("discovers with a configured %s without rewriting or leaking it", async (kind) => {
    const run = async (dir = "") => {
      const key = "fixture-configured-key";
      vi.stubEnv("DISCOVERY_CONFIGURED_KEY", key);
      vi.stubEnv("OPENAI_API_KEY", key);
      vi.stubEnv("CUSTOM_API_KEY", undefined);
      let apiKey: ModelProviderConfig["apiKey"] = key;
      let config: OpenClawConfig = {};
      const secretPath = path.join(dir, "key");
      if (kind === "environment marker") {
        apiKey = "OPENAI_API_KEY";
      }
      if (kind === "environment SecretRef") {
        apiKey = { source: "env", provider: "default", id: "DISCOVERY_CONFIGURED_KEY" };
      }
      if (kind === "file SecretRef") {
        await fs.writeFile(secretPath, key, { mode: 0o600 });
        apiKey = { source: "file", provider: "discovery", id: "value" };
        config.secrets = {
          providers: { discovery: { source: "file", path: secretPath, mode: "singleValue" } },
        };
      }
      config = { ...config, ...localConfig({ apiKey }) };
      if (kind.endsWith("profile")) {
        const provider = kind === "same-provider profile" ? "local" : "shared";
        apiKey = `${provider}:bound`;
        config = localConfig({ apiKey });
        config.models!.providers!.shared = {
          baseUrl: kind === "incompatible profile" ? "https://other.local/v1" : customBaseUrl,
          models: [],
        };
        resolveNonInteractiveApiKey.mockImplementation(
          async ({ allowProfile }: { allowProfile?: boolean }) =>
            provider === "local" && allowProfile !== false ? { key, source: "profile" } : null,
        );
        vi.spyOn(
          authProfileStore,
          "loadAuthProfileStoreWithoutExternalProfilesAsync",
        ).mockResolvedValue(
          createAuthProfileStoreFixture({ [apiKey]: createApiKeyCredential(provider, key) }),
        );
      }
      const request = mockAuthenticatedDiscovery(key);
      const result = await applyCustomChoice({ customProviderId: "local" }, config);
      if (kind === "incompatible profile") {
        expect(result).toBeNull();
        expect(request).not.toHaveBeenCalled();
      } else {
        expectDiscovered(result, apiKey);
        expect(request).toHaveBeenCalledOnce();
      }
      expect(JSON.stringify(runtime.log.mock.calls)).not.toContain(key);
    };
    if (kind === "file SecretRef") {
      await withTempDir("openclaw-discovery-key-", run);
    } else {
      await run();
    }
  });

  it("does not select a saved profile again after reset discovery", async () => {
    const request = forbidDiscovery();
    resolveNonInteractiveApiKey.mockImplementation(
      async ({ allowProfile }: { allowProfile?: boolean }) =>
        allowProfile === false ? null : { key: "fixture-old-profile-key", source: "profile" },
    );
    const result = await applyChoice({
      opts: {
        customBaseUrl: "https://replacement.example.com/v1",
        customProviderId: "local-2",
        customModelIds: ["first", "second"],
      },
    });
    expect(customProvider(result, "local-2")?.apiKey).toBeUndefined();
    expect(customProvider(result, "local-2")?.models.map((model) => model.id)).toEqual([
      "second",
      "first",
    ]);
    expectModelSelection(result, "local-2/first", ["local-2/first", "local-2/second"]);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ["first advertised", ["chat-prod", "new-chat"], undefined],
    ["last advertised", ["new-chat", "chat-prod"], undefined],
    ["explicit text-only override", ["chat-prod", "new-chat"], false],
  ] as const)(
    "preserves authored Azure discovery metadata (%s)",
    async (_name, modelIds, customImageInput) => {
      mockDiscovery(
        Response.json({ data: modelIds.map((id) => ({ id })) }),
        `${azureBaseUrl}/models`,
      );
      const { config, model } = createAzureCatalogConfig();
      const result = await applyChoice({
        nextConfig: config,
        opts: { customBaseUrl: azureBaseUrl, customProviderId: "local", customImageInput },
      });
      expect(customProvider(result, "local")?.models).toEqual([
        { ...model, ...(customImageInput === false ? { input: ["text"] } : {}) },
        {
          id: "new-chat",
          name: "new-chat (Custom Provider)",
          contextWindow: 400_000,
          maxTokens: 16_384,
          input: ["text"],
          reasoning: false,
          compat: { supportsStore: false },
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ]);
      expect(customProvider(result, "local")?.apiKey).toEqual(
        config.models?.providers?.local?.apiKey,
      );
      expect(customProvider(result, "local")?.headers).toEqual({
        "api-key": config.models?.providers?.local?.apiKey,
      });
      expect(result?.gateway).toEqual(config.gateway);
      expectModelSelection(result, `local/${modelIds[0]}`, ["local/chat-prod", "local/new-chat"]);
    },
  );

  it("keeps explicit Azure setup normalization", async () => {
    const request = forbidDiscovery();
    const { config, model } = createAzureCatalogConfig();
    const result = await applyChoice({
      nextConfig: config,
      opts: { customBaseUrl: azureBaseUrl, customProviderId: "local", customModelId: "chat-prod" },
    });
    expect(customProvider(result, "local")?.models).toEqual([
      { ...model, input: ["text"], reasoning: false, compat: { supportsStore: false } },
    ]);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    Response.json({ data: [] }),
    Response.json({ models: [] }),
    new Response("unavailable", { status: 503 }),
  ])("requires a manual model when discovery returns no usable ids (%#)", async (response) => {
    mockDiscovery(response);
    const result = await applyCustomChoice();
    expect(result).toBeNull();
    expect(runtime.error).toHaveBeenCalledWith(
      "No models could be discovered from the custom provider. Check the base URL and credentials, or pass --custom-model-id explicitly.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  registerCustomCatalogImportTests(applyChoice);

  it("keeps discovered models together when a provider id collides", async () => {
    const request = mockDiscovery(Response.json({ data: [{ id: "first" }, { id: "second" }] }));
    const result = await applyCustomChoice(
      { customProviderId: "local" },
      localConfig({ baseUrl: "https://other.example/v1", apiKey: "other-endpoint-key" }),
    );
    expect(Object.keys(result?.models?.providers ?? {})).toEqual(["local", "local-2"]);
    expect(new Headers(request.mock.calls[0]?.[0].init?.headers).has("Authorization")).toBe(false);
    expect(customProvider(result, "local-2")?.models.map((model) => model.id)).toEqual([
      "second",
      "first",
    ]);
    expectModelSelection(result, "local-2/first", ["local-2/first", "local-2/second"]);
  });

  it("stores custom provider env refs through the local auth-choice seam", async () => {
    const request = forbidDiscovery();
    resolveKey("env", "custom-env-key", "CUSTOM_API_KEY");
    const result = await applyManual();
    expect(customProvider(result)?.models).toEqual([
      expect.objectContaining({ id: "local-large" }),
    ]);
    expect(request).not.toHaveBeenCalled();
    expect(customProvider(result)?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "CUSTOM_API_KEY",
    });
    expect(resolveAgentModelPrimaryValue(result?.agents?.defaults?.model)).toBe(
      "custom-models-custom-local/local-large",
    );
    expect(resolveNonInteractiveApiKey).toHaveBeenCalledOnce();
    const [apiKeyParams] = resolveNonInteractiveApiKey.mock.calls[0] ?? [];
    expect(apiKeyParams).toMatchObject({
      provider: "custom-models-custom-local",
      flagName: "--custom-api-key",
      envVar: "CUSTOM_API_KEY",
      envVarName: "CUSTOM_API_KEY",
      agentDir: target.agentDir,
      secretInputMode: "ref",
    });
  });

  const unresolvedKey = {
    source: "env",
    provider: "default",
    id: "UNRESOLVED_DISCOVERY_KEY",
  } as const;
  it.each([
    ["explicit model", "local-large", undefined, false],
    ["saved inline key", undefined, "fixture-saved-key", false],
    ["persisted policy with inline key", undefined, "fixture-saved-key", true],
    ["persisted policy with unresolved SecretRef", undefined, unresolvedKey, true],
    ["unresolved SecretRef", undefined, unresolvedKey, false],
  ] as const)(
    "skips credentials for custom no-auth with %s",
    async (_name, modelId, apiKey, persisted) => {
      vi.stubEnv("CUSTOM_API_KEY", undefined);
      vi.stubEnv("UNRESOLVED_DISCOVERY_KEY", undefined);
      resolveNonInteractiveApiKey.mockResolvedValueOnce(
        persisted
          ? null
          : { key: "ambient-env-key-must-be-ignored", source: "env", envVarName: "CUSTOM_API_KEY" },
      );
      const request = mockAuthenticatedDiscovery();
      const result = await applyCustomChoice(
        { customProviderId: "local", customModelId: modelId, customNoAuth: !persisted },
        localConfig({ apiKey, ...(persisted ? { auth: "none" } : {}) }),
      );
      expect(
        request.mock.calls.map(([input]) => new Headers(input.init?.headers).get("authorization")),
      ).toEqual(modelId ? [] : [null]);
      expect(request).toHaveBeenCalledTimes(modelId ? 0 : 1);
      expect(customProvider(result, "local")).toMatchObject({
        auth: "none",
        models: [expect.objectContaining({ id: modelId ?? "discovered-chat" })],
      });
      expect(customProvider(result, "local")?.apiKey).toEqual(persisted ? apiKey : undefined);
      expect(resolveNonInteractiveApiKey).not.toHaveBeenCalled();
      expect(runtime.error).not.toHaveBeenCalled();
    },
  );

  it("never commits an existing profile key as plaintext during custom secret-ref onboarding", async () => {
    const profileKey = "fixture-custom-profile-secret";
    resolveKey("profile", profileKey);
    const result = await applyManual();
    expect(result).not.toBeNull();
    await commitNonInteractiveOnboardConfig({ nextConfig: result!, baseConfig: nextConfig });
    const persistedConfig = writeWizardConfigFile.mock.calls.at(-1)?.[0];
    expect(customProvider(persistedConfig ?? null)?.apiKey).toBeUndefined();
    expect(JSON.stringify(persistedConfig)).not.toContain(profileKey);
    expectCleanRuntime();
  });

  it.each([
    ["custom", "flag"],
    ["custom", "env"],
    ["plugin", "profile"],
    ["plugin", "env"],
  ] as const)("rejects unreferenceable %s %s credentials", async (kind, source) => {
    const key = "fixture-unreferenceable-secret";
    if (kind === "custom") {
      resolveKey(source, key);
      expect(await applyManual()).toBeNull();
      expect(writeWizardConfigFile).not.toHaveBeenCalled();
    } else {
      const convert = await pluginCredentialConverter();
      expect(convert({ provider: "demo-provider", resolved: { source, key } })).toBeNull();
    }
    expectSecretRejection(key, kind === "custom" ? "CUSTOM_API_KEY" : "demo-provider");
  });

  it("does not reformat an already-reported custom auth rejection", async () => {
    resolveKey("flag", "fixture-key");
    const exit = new ExitError(1);
    runtime.exit.mockImplementation(() => {
      throw exit;
    });
    await expect(applyManual({ json: true })).rejects.toBe(exit);
    expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(runtime.error).toHaveBeenCalledOnce();
    expect(runtime.log).toHaveBeenCalledOnce();
    const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0]));
    expect(payload).toMatchObject({
      ok: false,
      phase: "options",
      message: expect.stringContaining(
        "--secret-input-mode ref requires an explicit environment variable",
      ),
    });
    expect(payload.message).not.toContain("Invalid custom provider config");
    expect(writeWizardConfigFile).not.toHaveBeenCalled();
  });

  it("preserves existing custom SecretRefs when reusing an auth profile", async () => {
    const ref = { source: "exec", provider: "vault", id: "custom-provider" } as const;
    const providerId = "custom-models-custom-local";
    const profileConfig = localConfig({ apiKey: ref }, providerId);
    resolveKey("profile", "fixture-existing-profile-secret");
    const result = await applyManual({}, profileConfig);
    expect(customProvider(result, providerId)?.apiKey).toEqual(ref);
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it.each([
    ["ref", null, undefined],
    [
      "plaintext",
      { key: "fixture-plaintext-profile-key", source: "profile" },
      "fixture-plaintext-profile-key",
    ],
  ] as const)(
    "preserves optional custom credentials in %s mode",
    async (secretInputMode, resolved, expected) => {
      resolveNonInteractiveApiKey.mockResolvedValueOnce(resolved);
      const result = await applyManual({ secretInputMode });
      expect(customProvider(result)?.apiKey).toBe(expected);
      expectCleanRuntime();
    },
  );

  it("preserves env-backed plugin credentials and profile metadata in secret-ref mode", async () => {
    const toApiKeyCredential = await pluginCredentialConverter();
    expect(
      toApiKeyCredential({
        provider: "demo-provider",
        resolved: {
          key: "fixture-valid-plugin-env-secret",
          source: "env",
          envVarName: "DEMO_PROVIDER_API_KEY",
        },
        email: "operator@example.test",
        metadata: { account: "work" },
      }),
    ).toEqual({
      type: "api_key",
      provider: "demo-provider",
      keyRef: { source: "env", provider: "default", id: "DEMO_PROVIDER_API_KEY" },
      email: "operator@example.test",
      metadata: { account: "work" },
    });
    expectCleanRuntime();
  });

  it.each([
    [undefined, ["text", "image"]],
    [false, ["text"]],
  ] as const)("applies custom vision override %s", async (customImageInput, expected) => {
    resolveNonInteractiveApiKey.mockResolvedValueOnce(undefined);
    const result = await applyCustomChoice({ customModelId: "gpt-4o", customImageInput });
    expect(customProvider(result)?.models[0]?.input).toEqual(expected);
  });

  it.each([
    ["claude-cli", true],
    ["oauth", true],
    ["claude-cli", false],
  ] as const)("resolves legacy %s with replacement=%s", async (authChoice, hasReplacement) => {
    const expectedError =
      authChoice === "oauth" || !hasReplacement
        ? `Unknown --auth-choice "${authChoice}". Valid choices: custom-api-key, skip, demo-provider-api-key.`
        : undefined;
    const resolvedConfig: OpenClawConfig = { agents: { defaults: { workspace: "/tmp/resolved" } } };
    const warning = 'Auth choice "claude-cli" is deprecated; using Fixture Provider setup instead.';
    resolveManifestDeprecatedProviderAuthChoice.mockImplementation((choice, scope) =>
      hasReplacement &&
      choice === "claude-cli" &&
      scope?.config === nextConfig &&
      scope.workspaceDir === target.workspaceDir &&
      scope.env === process.env
        ? {
            pluginId: "fixture-provider",
            providerId: "fixture-provider",
            methodId: "api-key",
            choiceId: "demo-provider-api-key",
            choiceLabel: "  Fixture Provider  ",
            deprecatedChoiceIds: ["claude-cli"],
          }
        : undefined,
    );
    if (!expectedError) {
      applyNonInteractivePluginProviderChoice.mockResolvedValueOnce(resolvedConfig as never);
    }
    const result = await applyChoice({ authChoice, opts: {} });
    expect(writeWizardConfigFile).not.toHaveBeenCalled();
    expect(resolveNonInteractiveApiKey).not.toHaveBeenCalled();
    if (expectedError) {
      expect(result).toBeNull();
      expect(runtime.error).toHaveBeenCalledExactlyOnceWith(expectedError);
      expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(runtime.log).not.toHaveBeenCalled();
      expect(applyNonInteractivePluginProviderChoice).not.toHaveBeenCalled();
      return;
    }
    expect(result).toBe(resolvedConfig);
    expectCleanRuntime();
    expect(runtime.log).toHaveBeenCalledExactlyOnceWith(warning);
    expect(applyNonInteractivePluginProviderChoice).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ authChoice: "demo-provider-api-key", nextConfig, target }),
    );
    const warningOrder = runtime.log.mock.invocationCallOrder[0];
    const dispatchOrder = applyNonInteractivePluginProviderChoice.mock.invocationCallOrder[0];
    if (warningOrder === undefined || dispatchOrder === undefined) {
      throw new Error("Expected legacy warning and plugin dispatch");
    }
    expect(warningOrder).toBeLessThan(dispatchOrder);
  });
});
