import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
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
import { commitNonInteractiveOnboardConfig } from "../config-write.js";
import { registerCustomCatalogImportTests } from "./auth-choice.catalog.test-support.js";
import { applyNonInteractiveAuthChoice } from "./auth-choice.js";

const {
  writeWizardConfigFile,
  formatAuthChoiceChoicesForCli,
  applyPlugin,
  resolveApiKey,
  resolveManifestDeprecatedProviderAuthChoice,
  resolveManifestProviderAuthChoices,
  resolveDeprecatedProviderInstallCatalogEntry,
} = vi.hoisted(() => ({
  writeWizardConfigFile: vi.fn(async (config: OpenClawConfig) => ({
    path: "/tmp/openclaw.json",
    nextConfig: config,
  })),
  formatAuthChoiceChoicesForCli: vi.fn(() => "custom-api-key|skip|demo-provider-api-key"),
  applyPlugin: vi.fn<
    typeof import("./auth-choice.plugin-providers.js").applyNonInteractivePluginProviderChoice
  >(async () => undefined),
  resolveApiKey: vi.fn(),
  resolveManifestDeprecatedProviderAuthChoice: vi.fn<
    typeof import("../../../plugins/provider-auth-choices.js").resolveManifestDeprecatedProviderAuthChoice
  >(() => undefined),
  resolveManifestProviderAuthChoices: vi.fn(() => []),
  resolveDeprecatedProviderInstallCatalogEntry: vi.fn(() => undefined),
}));
vi.mock("../../../wizard/setup.shared.js", () => ({ writeWizardConfigFile }));
// mock-isolation: The fixed choice list avoids installed-provider discovery in dispatch tests.
vi.mock("../../auth-choice-options.js", () => ({ formatAuthChoiceChoicesForCli }));

// mock-isolation: Capture provider dispatch without loading or installing real providers.
vi.mock("./auth-choice.plugin-providers.js", () => ({
  applyNonInteractivePluginProviderChoice: applyPlugin,
}));

// mock-isolation: Tests provide synthetic credential resolution without reading host secrets.
vi.mock("../api-keys.js", () => ({ resolveNonInteractiveApiKey: resolveApiKey }));

vi.mock("../../../plugins/provider-auth-choices.js", () => ({
  resolveManifestDeprecatedProviderAuthChoice,
  resolveManifestProviderAuthChoices,
}));
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
  applyPlugin.mockReset().mockResolvedValue(undefined);
  resolveApiKey.mockReset();
  resolveManifestDeprecatedProviderAuthChoice.mockReset().mockReturnValue(undefined);
  resolveManifestProviderAuthChoices.mockReset().mockReturnValue([]);
  resolveDeprecatedProviderInstallCatalogEntry.mockReset().mockReturnValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const azureBaseUrl = "https://fixture.openai.azure.com/openai/v1";

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
function applyCustom(opts: ChoiceParams["opts"] = {}, config = nextConfig) {
  return applyChoice({ nextConfig: config, opts: { customBaseUrl, ...opts } });
}

function localConfig(settings: Partial<ModelProviderConfig> = {}, id = "local"): OpenClawConfig {
  return { models: { providers: { [id]: { baseUrl: customBaseUrl, models: [], ...settings } } } };
}

const authoredModel: ModelDefinitionConfig = {
  id: "chat-prod",
  name: "Authored",
  contextWindow: 65_536,
  maxTokens: 2048,
  reasoning: true,
  input: ["text", "image"],
  compat: { supportsStore: true, supportsDeveloperRole: false },
  cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
};

function applyManual(opts: ChoiceParams["opts"] = {}, config = nextConfig) {
  return applyCustom({ customModelId: "local-large", secretInputMode: "ref", ...opts }, config);
}

function provider(config: OpenClawConfig | null, id = "custom-models-custom-local") {
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
  expect(provider(config, "local")?.models).toEqual([
    expect.objectContaining({ id: "discovered-chat" }),
  ]);
  expect(provider(config, "local")?.apiKey).toEqual(apiKey);
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

function authenticateDiscovery(key?: string) {
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
  resolveApiKey.mockResolvedValueOnce({ source, key, envVarName });
}

async function pluginCredentialConverter() {
  applyPlugin.mockResolvedValueOnce(nextConfig);
  await applyChoice({ authChoice: "demo-provider-api-key", opts: { secretInputMode: "ref" } });
  const params = applyPlugin.mock.calls.at(-1)?.[0];
  expect(params).toBeDefined();
  return params!.toApiKeyCredential;
}

describe("applyNonInteractiveAuthChoice", () => {
  it.each(["definitely-not-a-provider", "oauth", "claude-cli"])(
    "rejects unknown %s",
    async (authChoice) => {
      const message = `Unknown --auth-choice "${authChoice}". Valid choices: custom-api-key, skip, demo-provider-api-key.`;
      const result = await applyChoice({
        authChoice,
        opts: { json: true },
      });
      expect(result).toBeNull();
      expect(runtime.error).toHaveBeenCalledExactlyOnceWith(message);
      expect(JSON.parse(String(runtime.log.mock.calls[0]?.[0])).message).toBe(message);
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(applyPlugin).not.toHaveBeenCalled();
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
    expect(applyPlugin).not.toHaveBeenCalled();
  });

  const discoveryKey = "fixture-configured-key";
  it.each([
    [discoveryKey, undefined, true],
    ["OPENAI_API_KEY", undefined, true],
    [{ source: "env", provider: "default", id: "DISCOVERY_CONFIGURED_KEY" }, undefined, true],
    [{ source: "file", provider: "discovery", id: "value" }, undefined, true],
    ["shared:bound", "shared", true],
    ["shared:bound", "shared", false],
    ["local:bound", "local", true],
  ] as const)(
    "discovers with %j (profile: %s, compatible: %s)",
    async (apiKey, profile, compatible) => {
      const run = async (dir = "") => {
        vi.stubEnv("DISCOVERY_CONFIGURED_KEY", discoveryKey);
        vi.stubEnv("OPENAI_API_KEY", discoveryKey);
        vi.stubEnv("CUSTOM_API_KEY", undefined);
        const config = localConfig({ apiKey });
        if (typeof apiKey === "object" && apiKey.source === "file") {
          const secretPath = path.join(dir, "key");
          await fs.writeFile(secretPath, discoveryKey, { mode: 0o600 });
          config.secrets = {
            providers: { discovery: { source: "file", path: secretPath, mode: "singleValue" } },
          };
        }
        if (profile) {
          config.models!.providers!.shared = {
            baseUrl: compatible ? customBaseUrl : "https://other.local/v1",
            models: [],
          };
          resolveApiKey.mockImplementation(async ({ allowProfile }: { allowProfile?: boolean }) =>
            profile === "local" && allowProfile !== false
              ? { key: discoveryKey, source: "profile" }
              : null,
          );
          vi.spyOn(
            authProfileStore,
            "loadAuthProfileStoreWithoutExternalProfilesAsync",
          ).mockResolvedValue(
            createAuthProfileStoreFixture({
              [apiKey]: createApiKeyCredential(profile, discoveryKey),
            }),
          );
        }
        const request = authenticateDiscovery(discoveryKey);
        const result = await applyCustom({ customProviderId: "local" }, config);
        if (compatible) {
          expectDiscovered(result, apiKey);
        } else {
          expect(result).toBeNull();
          expect(request).not.toHaveBeenCalled();
        }
        expect(JSON.stringify(runtime.log.mock.calls)).not.toContain(discoveryKey);
      };
      if (typeof apiKey === "object" && apiKey.source === "file") {
        await withTempDir("openclaw-discovery-key-", run);
      } else {
        await run();
      }
    },
  );

  it("does not select a saved profile again after reset discovery", async () => {
    const request = forbidDiscovery();
    resolveApiKey.mockImplementation(async ({ allowProfile }: { allowProfile?: boolean }) =>
      allowProfile === false ? null : { key: "fixture-old-profile-key", source: "profile" },
    );
    const result = await applyChoice({
      opts: {
        customBaseUrl: "https://replacement.example.com/v1",
        customProviderId: "local-2",
        customModelIds: ["first", "second"],
      },
    });
    expect(provider(result, "local-2")?.apiKey).toBeUndefined();
    expect(provider(result, "local-2")?.models.map((model) => model.id)).toEqual([
      "second",
      "first",
    ]);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ["discovered", undefined],
    ["text-only", false],
    ["explicit", undefined],
  ] as const)("applies Azure metadata policy for %s models", async (mode, customImageInput) => {
    const explicit = mode === "explicit";
    const request = explicit
      ? forbidDiscovery()
      : mockDiscovery(
          Response.json({
            data: [
              { id: " new-chat " },
              { id: "chat-prod" },
              { id: "new-chat" },
              { id: " " },
              { id: 7 },
            ],
          }),
          `${azureBaseUrl}/models`,
        );
    vi.stubEnv("AZURE_DISCOVERY_TEST_KEY", "fixture-azure-key");
    const model = authoredModel;
    const apiKey = { source: "env", provider: "default", id: "AZURE_DISCOVERY_TEST_KEY" } as const;
    const config = localConfig({
      baseUrl: azureBaseUrl,
      api: "azure-openai-responses",
      apiKey,
      models: [model],
    });
    const result = await applyChoice({
      nextConfig: config,
      opts: {
        customBaseUrl: azureBaseUrl,
        customProviderId: "local",
        customImageInput,
        customModelId: explicit ? "chat-prod" : undefined,
      },
    });
    const expectedModel = explicit
      ? { ...model, input: ["text"], reasoning: false, compat: { supportsStore: false } }
      : { ...model, ...(customImageInput === false ? { input: ["text"] } : {}) };
    expect(provider(result, "local")?.models).toEqual([
      expectedModel,
      ...(explicit ? [] : [expect.objectContaining({ id: "new-chat" })]),
    ]);
    expect(provider(result, "local")?.apiKey).toEqual(apiKey);
    expect(provider(result, "local")?.headers).toEqual({ "api-key": apiKey });
    if (explicit) {
      expect(request).not.toHaveBeenCalled();
    }
  });

  it.each([Response.json({ data: [] }), new Response("unavailable", { status: 503 })])(
    "requires a manual model when discovery returns no usable ids (%#)",
    async (response) => {
      mockDiscovery(response);
      const result = await applyCustom();
      expect(result).toBeNull();
      expect(runtime.error).toHaveBeenCalledWith(
        "No models could be discovered from the custom provider. Check the base URL and credentials, or pass --custom-model-id explicitly.",
      );
      expect(runtime.exit).toHaveBeenCalledWith(1);
    },
  );

  registerCustomCatalogImportTests(applyChoice);

  it("keeps discovered models together when a provider id collides", async () => {
    const request = mockDiscovery(Response.json({ data: [{ id: "first" }, { id: "second" }] }));
    const result = await applyCustom(
      { customProviderId: "local" },
      localConfig({ baseUrl: "https://other.example/v1", apiKey: "other-endpoint-key" }),
    );
    expect(provider(result, "local")?.baseUrl).toBe("https://other.example/v1");
    expect(new Headers(request.mock.calls[0]?.[0].init?.headers).has("Authorization")).toBe(false);
    expect(resolveAgentModelPrimaryValue(result?.agents?.defaults?.model)).toBe("local-2/first");
    expect(result?.agents?.defaults?.models).toHaveProperty("local-2/second");
  });

  it.each([
    ["openai", undefined, ["text", "image"]],
    ["openai-responses", false, ["text"]],
  ] as const)(
    "stores env refs and model capabilities with %s",
    async (customCompatibility, customImageInput, input) => {
      const request = forbidDiscovery();
      resolveKey("env", "custom-env-key", "CUSTOM_API_KEY");
      const result = await applyManual({
        customCompatibility,
        customImageInput,
        customModelId: "gpt-4o",
      });
      expect(provider(result)?.models).toEqual([expect.objectContaining({ id: "gpt-4o", input })]);
      expect(request).not.toHaveBeenCalled();
      expect(provider(result)?.apiKey).toEqual({
        source: "env",
        provider: "default",
        id: "CUSTOM_API_KEY",
      });
      expect(provider(result)?.api).toBe(
        customCompatibility === "openai" ? "openai-completions" : "openai-responses",
      );
      expect(resolveAgentModelPrimaryValue(result?.agents?.defaults?.model)).toBe(
        "custom-models-custom-local/gpt-4o",
      );
      const [apiKeyParams] = resolveApiKey.mock.calls[0] ?? [];
      expect(apiKeyParams).toMatchObject({
        provider: "custom-models-custom-local",
        agentDir: target.agentDir,
        secretInputMode: "ref",
      });
    },
  );

  const unresolvedKey = {
    source: "env",
    provider: "default",
    id: "UNRESOLVED_DISCOVERY_KEY",
  } as const;
  it.each([
    [false, "fixture-saved-key"],
    [true, unresolvedKey],
  ] as const)("skips custom no-auth credentials (persisted: %s)", async (persisted, apiKey) => {
    vi.stubEnv("CUSTOM_API_KEY", undefined);
    vi.stubEnv("UNRESOLVED_DISCOVERY_KEY", undefined);
    resolveApiKey.mockResolvedValueOnce(
      persisted
        ? null
        : { key: "ambient-env-key-must-be-ignored", source: "env", envVarName: "CUSTOM_API_KEY" },
    );
    const request = authenticateDiscovery();
    const result = await applyCustom(
      { customProviderId: "local", customNoAuth: !persisted },
      localConfig({ apiKey, ...(persisted ? { auth: "none" } : {}) }),
    );
    expect(
      request.mock.calls.map(([input]) => new Headers(input.init?.headers).get("authorization")),
    ).toEqual([null]);
    expect(provider(result, "local")).toMatchObject({
      auth: "none",
      models: [expect.objectContaining({ id: "discovered-chat" })],
    });
    expect(provider(result, "local")?.apiKey).toEqual(persisted ? apiKey : undefined);
    expect(resolveApiKey).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
  });

  const existingRef = { source: "exec", provider: "vault", id: "custom-provider" } as const;
  it.each([
    ["ref", "fixture-profile-key", undefined],
    ["ref", "fixture-profile-key", existingRef],
    ["ref", null, undefined],
    ["plaintext", "fixture-profile-key", undefined],
  ] as const)(
    "persists optional/profile credentials in %s mode (%j, %j)",
    async (secretInputMode, key, apiKey) => {
      resolveApiKey.mockResolvedValueOnce(key ? { source: "profile", key } : null);
      const config = apiKey ? localConfig({ apiKey }, "custom-models-custom-local") : nextConfig;
      const result = await applyManual({ secretInputMode }, config);
      expect(result).not.toBeNull();
      expect(provider(result)?.apiKey).toEqual(secretInputMode === "plaintext" ? key : apiKey);
      await commitNonInteractiveOnboardConfig({ nextConfig: result!, baseConfig: config });
      const persistedConfig = writeWizardConfigFile.mock.calls.at(-1)?.[0];
      expect(provider(persistedConfig ?? null)?.apiKey).toEqual(
        secretInputMode === "plaintext" ? key : apiKey,
      );
      if (secretInputMode === "ref" && key) {
        expect(JSON.stringify(persistedConfig)).not.toContain(key);
      }
      expectCleanRuntime();
    },
  );

  it.each([
    ["custom", "flag", undefined, false],
    ["custom", "env", undefined, false],
    ["plugin", "profile", undefined, false],
    ["plugin", "env", undefined, false],
    ["plugin", "env", "DEMO_PROVIDER_API_KEY", false],
    ["custom", "flag", undefined, true],
  ] as const)(
    "converts %s %s credentials (ref: %s, throws: %s)",
    async (kind, source, envVarName, throws) => {
      const key = "fixture-credential-secret";
      const metadata = { email: "operator@example.test", metadata: { account: "work" } };
      const exit = new ExitError(1);
      if (throws) {
        runtime.exit.mockImplementation(() => {
          throw exit;
        });
      }
      if (kind === "custom") {
        resolveKey(source, key);
        const result = applyManual({ json: throws });
        if (throws) {
          await expect(result).rejects.toBe(exit);
          expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
          expect(runtime.error).toHaveBeenCalledOnce();
          expect(runtime.log).toHaveBeenCalledOnce();
          const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0]));
          expect(payload.message).not.toContain("Invalid custom provider config");
        } else {
          expect(await result).toBeNull();
        }
        expect(writeWizardConfigFile).not.toHaveBeenCalled();
      } else {
        const convert = await pluginCredentialConverter();
        const credential = convert({
          provider: "demo-provider",
          resolved: { source, key, envVarName },
          ...metadata,
        });
        if (envVarName) {
          expect(credential).toEqual({
            type: "api_key",
            provider: "demo-provider",
            keyRef: { source: "env", provider: "default", id: envVarName },
            ...metadata,
          });
          expectCleanRuntime();
          return;
        }
        expect(credential).toBeNull();
      }
      expectSecretRejection(key, kind === "custom" ? "CUSTOM_API_KEY" : "demo-provider");
    },
  );

  it("warns before dispatching a legacy replacement", async () => {
    const resolvedConfig: OpenClawConfig = { agents: { defaults: { workspace: "/tmp/resolved" } } };
    const warning = 'Auth choice "claude-cli" is deprecated; using Fixture Provider setup instead.';
    resolveManifestDeprecatedProviderAuthChoice.mockImplementation((choice, scope) =>
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
    applyPlugin.mockResolvedValueOnce(resolvedConfig);
    const result = await applyChoice({ authChoice: "claude-cli" });
    expect(result).toBe(resolvedConfig);
    expectCleanRuntime();
    expect(runtime.log).toHaveBeenCalledExactlyOnceWith(warning);
    expect(applyPlugin).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ authChoice: "demo-provider-api-key", nextConfig, target }),
    );
    const warningOrder = expectDefined(runtime.log.mock.invocationCallOrder[0], "legacy warning");
    const dispatchOrder = expectDefined(
      applyPlugin.mock.invocationCallOrder[0],
      "provider dispatch",
    );
    expect(warningOrder).toBeLessThan(dispatchOrder);
  });
});
