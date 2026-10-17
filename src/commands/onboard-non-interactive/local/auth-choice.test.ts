// Non-interactive auth-choice tests cover built-in, custom, deprecated, and plugin provider dispatch.
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
import type { ModelDefinitionConfig } from "../../../config/types.models.js";
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
vi.mock("../../auth-choice-options.js", () => ({
  formatAuthChoiceChoicesForCli,
}));

const applyNonInteractivePluginProviderChoice = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("./auth-choice.plugin-providers.js", () => ({
  applyNonInteractivePluginProviderChoice,
}));

const resolveNonInteractiveApiKey = vi.hoisted(() => vi.fn());
vi.mock("../api-keys.js", () => ({
  resolveNonInteractiveApiKey,
}));

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
    id: "chat-prod",
    name: "Production chat",
    contextWindow: 65_536,
    maxTokens: 8192,
    input: ["text", "image"],
    reasoning: true,
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
  return {
    error: vi.fn(),
    exit: vi.fn(),
    log: vi.fn(),
  };
}

const target = {
  agentId: "main",
  agentDir: "/tmp/main-agent",
  workspaceDir: "/tmp/workspace",
};

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

  it("continues to apply an enumerated provider auth choice", async () => {
    const resolvedConfig = { auth: { profiles: { "demo-provider:default": { mode: "api_key" } } } };
    applyNonInteractivePluginProviderChoice.mockResolvedValueOnce(resolvedConfig as never);

    const result = await applyChoice({
      nextConfig,
      authChoice: "demo-provider-api-key",
    });

    expect(result).toBe(resolvedConfig);
    expect(applyNonInteractivePluginProviderChoice).toHaveBeenCalledWith(
      expect.objectContaining({ target }),
    );
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("resolves generic provider auth from the selected agent workspace", async () => {
    const resolvedConfig = { auth: { profiles: { "demo-provider:default": { mode: "api_key" } } } };
    applyNonInteractivePluginProviderChoice.mockResolvedValueOnce(resolvedConfig as never);
    const normalize = vi
      .spyOn(apiProviderAuthChoices, "normalizeApiKeyTokenProviderAuthChoice")
      .mockImplementation((params) =>
        params.workspaceDir === target.workspaceDir ? "demo-provider-api-key" : params.authChoice,
      );

    try {
      const result = await applyChoice({
        nextConfig,
        authChoice: "apiKey",
        opts: { tokenProvider: "demo-provider" },
      });

      expect(result).toBe(resolvedConfig);
      expect(runtime.error).not.toHaveBeenCalled();
    } finally {
      normalize.mockRestore();
    }
  });

  it("escapes deprecated auth choice guidance for terminal output", async () => {
    resolveManifestDeprecatedProviderAuthChoice.mockReturnValueOnce({
      choiceId: "modern\nchoice",
    } as never);

    const result = await applyChoice({
      nextConfig,
      authChoice: "legacy\u001b[31mchoice",
    });

    expect(result).toBeNull();
    expect(runtime.error).toHaveBeenCalledWith(
      '"legacy\\u001b[31mchoice" is no longer supported. Use --auth-choice "modern\\nchoice" instead.',
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(applyNonInteractivePluginProviderChoice).not.toHaveBeenCalled();
  });

  it("keeps replacement guidance for deprecated install-catalog choices", async () => {
    resolveDeprecatedProviderInstallCatalogEntry.mockReturnValueOnce({
      choiceId: "qwen-api-key",
    } as never);

    const result = await applyChoice({
      nextConfig,
      authChoice: "modelstudio-api-key",
    });

    expect(result).toBeNull();
    expect(runtime.error).toHaveBeenCalledWith(
      '"modelstudio-api-key" is no longer supported. Use --auth-choice "qwen-api-key" instead.',
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(applyNonInteractivePluginProviderChoice).not.toHaveBeenCalled();
  });

  it.each(["openai", "openai-responses"] as const)(
    "imports discovered %s models and keeps authored metadata",
    async (compatibility) => {
      const request = vi.spyOn(fetchGuard, "fetchWithSsrFGuard").mockResolvedValue({
        response: Response.json({
          data: [
            { id: " local-large " },
            { id: "local-small" },
            { id: "local-large" },
            { id: " " },
            { id: 7 },
          ],
        }),
        finalUrl: "https://models.custom.local/v1/models",
        release: async () => {},
      });
      resolveNonInteractiveApiKey.mockResolvedValueOnce({
        key: "fixture-discovery-key",
        source: "env",
        envVarName: "CUSTOM_API_KEY",
      });
      const authored = {
        id: "local-large",
        name: "Authored",
        contextWindow: 65_536,
        maxTokens: 2048,
        reasoning: true,
        input: ["text" as const],
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      };
      const result = await applyChoice({
        nextConfig: {
          models: {
            providers: {
              local: {
                baseUrl: "https://models.custom.local/v1",
                models: [authored],
              },
            },
          },
        },
        opts: {
          customBaseUrl: "https://models.custom.local/v1",
          customProviderId: "local",
          customCompatibility: compatibility,
        },
      });
      expect(result?.models?.providers?.local?.models).toEqual([
        authored,
        expect.objectContaining({ id: "local-small" }),
      ]);
      expect(resolveAgentModelPrimaryValue(result?.agents?.defaults?.model)).toBe(
        "local/local-large",
      );
      expect(result?.agents?.defaults?.models).toMatchObject({
        "local/local-large": {},
        "local/local-small": {},
      });
      expect(request).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          url: "https://models.custom.local/v1/models",
          init: { headers: { Authorization: "Bearer fixture-discovery-key" } },
        }),
      );
    },
  );

  it.each([
    { name: "inline", apiKey: "fixture-configured-key" },
    { name: "environment marker", apiKey: "OPENAI_API_KEY" },
    {
      name: "environment SecretRef",
      apiKey: { source: "env", provider: "default", id: "DISCOVERY_CONFIGURED_KEY" },
    },
  ] as const)(
    "uses the configured $name key for discovery without rewriting it",
    async ({ apiKey }) => {
      vi.stubEnv("DISCOVERY_CONFIGURED_KEY", "fixture-configured-key");
      vi.stubEnv("OPENAI_API_KEY", "fixture-configured-key");
      vi.stubEnv("CUSTOM_API_KEY", undefined);
      const request = vi
        .spyOn(fetchGuard, "fetchWithSsrFGuard")
        .mockImplementation(async (input) => ({
          response:
            new Headers(input.init?.headers).get("Authorization") ===
            "Bearer fixture-configured-key"
              ? Response.json({ data: [{ id: "discovered-chat" }] })
              : new Response(null, { status: 401 }),
          finalUrl: input.url,
          release: async () => {},
        }));
      const config: OpenClawConfig = {
        models: {
          providers: { local: { baseUrl: "https://models.custom.local/v1", apiKey, models: [] } },
        },
      };
      const result = await applyChoice({
        nextConfig: config,
        opts: { customBaseUrl: "https://models.custom.local/v1", customProviderId: "local" },
      });
      expect(result?.models?.providers?.local?.models).toEqual([
        expect.objectContaining({ id: "discovered-chat" }),
      ]);
      expect(result?.models?.providers?.local?.apiKey).toEqual(apiKey);
      expect(request).toHaveBeenCalledOnce();
      expect(runtime.error).not.toHaveBeenCalled();
      expect(JSON.stringify(runtime.log.mock.calls)).not.toContain("fixture-configured-key");
    },
  );

  it("resolves a configured file SecretRef through the secret owner for discovery", async () => {
    await withTempDir("openclaw-discovery-key-", async (dir) => {
      const secretPath = path.join(dir, "key");
      await fs.writeFile(secretPath, "fixture-file-key", { mode: 0o600 });
      const apiKey = { source: "file", provider: "discovery", id: "value" } as const;
      const config: OpenClawConfig = {
        secrets: {
          providers: { discovery: { source: "file", path: secretPath, mode: "singleValue" } },
        },
        models: {
          providers: { local: { baseUrl: "https://models.custom.local/v1", apiKey, models: [] } },
        },
      };
      vi.spyOn(fetchGuard, "fetchWithSsrFGuard").mockImplementation(async (input) => ({
        response:
          new Headers(input.init?.headers).get("Authorization") === "Bearer fixture-file-key"
            ? Response.json({ data: [{ id: "discovered-chat" }] })
            : new Response(null, { status: 401 }),
        finalUrl: input.url,
        release: async () => {},
      }));
      const result = await applyChoice({
        nextConfig: config,
        opts: { customBaseUrl: "https://models.custom.local/v1", customProviderId: "local" },
      });
      expect(result?.models?.providers?.local?.models).toEqual([
        expect.objectContaining({ id: "discovered-chat" }),
      ]);
      expect(result?.models?.providers?.local?.apiKey).toEqual(apiKey);
      expect(runtime.error).not.toHaveBeenCalled();
      expect(JSON.stringify(runtime.log.mock.calls)).not.toContain("fixture-file-key");
    });
  });

  it.each([
    { name: "shared endpoint", profileProvider: "shared", sameEndpoint: true },
    { name: "different endpoint", profileProvider: "shared", sameEndpoint: false },
    { name: "same provider", profileProvider: "local", sameEndpoint: true },
  ])(
    "honors configured profile endpoint compatibility ($name)",
    async ({ profileProvider, sameEndpoint }) => {
      const profileId = `${profileProvider}:bound`;
      resolveNonInteractiveApiKey.mockImplementation(
        async ({ allowProfile }: { allowProfile?: boolean }) =>
          profileProvider === "local" && allowProfile !== false
            ? { key: "fixture-bound-key", source: "profile" }
            : null,
      );
      vi.spyOn(
        authProfileStore,
        "loadAuthProfileStoreWithoutExternalProfilesAsync",
      ).mockResolvedValue(
        createAuthProfileStoreFixture({
          [profileId]: createApiKeyCredential(profileProvider, "fixture-bound-key"),
        }),
      );
      const request = vi
        .spyOn(fetchGuard, "fetchWithSsrFGuard")
        .mockImplementation(async (input) => ({
          response:
            new Headers(input.init?.headers).get("Authorization") === "Bearer fixture-bound-key"
              ? Response.json({ data: [{ id: "discovered-chat" }] })
              : new Response(null, { status: 401 }),
          finalUrl: input.url,
          release: async () => {},
        }));
      const result = await applyChoice({
        nextConfig: {
          models: {
            providers: {
              local: {
                baseUrl: "https://models.custom.local/v1",
                apiKey: profileId,
                models: [],
              },
              shared: {
                baseUrl: sameEndpoint ? "https://models.custom.local/v1" : "https://other.local/v1",
                models: [],
              },
            },
          },
        },
        opts: { customBaseUrl: "https://models.custom.local/v1", customProviderId: "local" },
      });
      if (sameEndpoint) {
        expect(result?.models?.providers?.local?.models).toEqual([
          expect.objectContaining({ id: "discovered-chat" }),
        ]);
        expect(result?.models?.providers?.local?.apiKey).toBe(profileId);
      } else {
        expect(result).toBeNull();
        expect(request).not.toHaveBeenCalled();
      }
      expect(JSON.stringify(runtime.log.mock.calls)).not.toContain("fixture-bound-key");
    },
  );

  it("does not select a saved profile again after reset discovery", async () => {
    resolveNonInteractiveApiKey.mockImplementation(
      async ({ allowProfile }: { allowProfile?: boolean }) =>
        allowProfile === false ? null : { key: "fixture-old-profile-key", source: "profile" },
    );
    const result = await applyChoice({
      opts: {
        customBaseUrl: "https://replacement.example.com/v1",
        customProviderId: "local-2",
        customModelIds: ["prepared-chat"],
      },
    });
    expect(result?.models?.providers?.["local-2"]?.apiKey).toBeUndefined();
    expect(result?.models?.providers?.["local-2"]?.models).toEqual([
      expect.objectContaining({ id: "prepared-chat" }),
    ]);
  });

  it.each([
    { name: "first advertised", modelIds: ["chat-prod", "new-chat"], customImageInput: undefined },
    { name: "last advertised", modelIds: ["new-chat", "chat-prod"], customImageInput: undefined },
    {
      name: "explicit text-only override",
      modelIds: ["chat-prod", "new-chat"],
      customImageInput: false,
    },
  ])(
    "preserves authored Azure discovery metadata ($name)",
    async ({ modelIds, customImageInput }) => {
      vi.spyOn(fetchGuard, "fetchWithSsrFGuard").mockResolvedValue({
        response: Response.json({ data: modelIds.map((id) => ({ id })) }),
        finalUrl: `${azureBaseUrl}/models`,
        release: async () => {},
      });
      const { config, model } = createAzureCatalogConfig();
      const result = await applyChoice({
        nextConfig: config,
        opts: { customBaseUrl: azureBaseUrl, customProviderId: "local", customImageInput },
      });
      expect(result?.models?.providers?.local?.models).toEqual([
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
      expect(result?.models?.providers?.local?.apiKey).toEqual(
        config.models?.providers?.local?.apiKey,
      );
      expect(result?.models?.providers?.local?.headers).toEqual({
        "api-key": config.models?.providers?.local?.apiKey,
      });
      expect(result?.gateway).toEqual(config.gateway);
      expect(result?.agents?.defaults?.models).toMatchObject({
        "local/chat-prod": {},
        "local/new-chat": {},
      });
      expect(resolveAgentModelPrimaryValue(result?.agents?.defaults?.model)).toBe(
        `local/${modelIds[0]}`,
      );
    },
  );

  it("keeps explicit Azure setup normalization", async () => {
    const request = vi
      .spyOn(fetchGuard, "fetchWithSsrFGuard")
      .mockRejectedValue(new Error("Unexpected discovery request"));
    const { config, model } = createAzureCatalogConfig();
    const result = await applyChoice({
      nextConfig: config,
      opts: { customBaseUrl: azureBaseUrl, customProviderId: "local", customModelId: "chat-prod" },
    });
    expect(result?.models?.providers?.local?.models).toEqual([
      { ...model, input: ["text"], reasoning: false, compat: { supportsStore: false } },
    ]);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    Response.json({ data: [] }),
    Response.json({ models: [] }),
    new Response("unavailable", { status: 503 }),
  ])("requires a manual model when discovery returns no usable ids (%#)", async (response) => {
    vi.spyOn(fetchGuard, "fetchWithSsrFGuard").mockResolvedValue({
      response,
      finalUrl: "https://models.custom.local/v1/models",
      release: async () => {},
    });
    const result = await applyChoice({ opts: { customBaseUrl: "https://models.custom.local/v1" } });
    expect(result).toBeNull();
    expect(runtime.error).toHaveBeenCalledWith(
      "No models could be discovered from the custom provider. Check the base URL and credentials, or pass --custom-model-id explicitly.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  registerCustomCatalogImportTests(applyChoice);

  it("uses model ids prepared before reset without rediscovery", async () => {
    const request = vi
      .spyOn(fetchGuard, "fetchWithSsrFGuard")
      .mockRejectedValue(new Error("Unexpected discovery request"));
    const result = await applyChoice({
      opts: {
        customBaseUrl: "https://models.custom.local/v1",
        customModelIds: ["first", "second"],
      },
    });
    expect(
      result?.models?.providers?.["custom-models-custom-local"]?.models.map((model) => model.id),
    ).toEqual(["second", "first"]);
    expect(resolveAgentModelPrimaryValue(result?.agents?.defaults?.model)).toBe(
      "custom-models-custom-local/first",
    );
    expect(result?.agents?.defaults?.models).toMatchObject({
      "custom-models-custom-local/first": {},
      "custom-models-custom-local/second": {},
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps discovered models together when a provider id collides", async () => {
    const request = vi.spyOn(fetchGuard, "fetchWithSsrFGuard").mockResolvedValue({
      response: Response.json({ data: [{ id: "first" }, { id: "second" }] }),
      finalUrl: "https://models.custom.local/v1/models",
      release: async () => {},
    });
    const result = await applyChoice({
      nextConfig: {
        models: {
          providers: {
            local: {
              baseUrl: "https://other.example/v1",
              apiKey: "other-endpoint-key",
              models: [],
            },
          },
        },
      },
      opts: { customBaseUrl: "https://models.custom.local/v1", customProviderId: "local" },
    });
    expect(Object.keys(result?.models?.providers ?? {})).toEqual(["local", "local-2"]);
    expect(new Headers(request.mock.calls[0]?.[0].init?.headers).has("Authorization")).toBe(false);
    expect(result?.models?.providers?.["local-2"]?.models.map((model) => model.id)).toEqual([
      "second",
      "first",
    ]);
    expect(resolveAgentModelPrimaryValue(result?.agents?.defaults?.model)).toBe("local-2/first");
    expect(result?.agents?.defaults?.models).toMatchObject({
      "local-2/first": {},
      "local-2/second": {},
    });
  });

  it("keeps an explicit model authoritative without discovering", async () => {
    const request = vi
      .spyOn(fetchGuard, "fetchWithSsrFGuard")
      .mockRejectedValue(new Error("Unexpected discovery request"));
    const result = await applyChoice({
      opts: {
        customBaseUrl: "https://models.custom.local/v1",
        customModelId: "manual-model",
      },
    });
    expect(result?.models?.providers?.["custom-models-custom-local"]?.models).toEqual([
      expect.objectContaining({ id: "manual-model" }),
    ]);
    expect(request).not.toHaveBeenCalled();
  });

  it("stores custom provider env refs through the local auth-choice seam", async () => {
    resolveNonInteractiveApiKey.mockResolvedValueOnce({
      key: "custom-env-key",
      source: "env",
      envVarName: "CUSTOM_API_KEY",
    });

    const result = await applyChoice({
      nextConfig,
      opts: {
        customBaseUrl: "https://models.custom.local/v1",
        customModelId: "local-large",
        secretInputMode: "ref",
      } as never,
    });

    expect(result?.models?.providers?.["custom-models-custom-local"]?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "CUSTOM_API_KEY",
    });
    expect(resolveAgentModelPrimaryValue(result?.agents?.defaults?.model)).toBe(
      "custom-models-custom-local/local-large",
    );
    expect(resolveNonInteractiveApiKey).toHaveBeenCalledOnce();
    const [apiKeyParams] = resolveNonInteractiveApiKey.mock.calls[0] ?? [];
    expect(apiKeyParams?.provider).toBe("custom-models-custom-local");
    expect(apiKeyParams?.flagName).toBe("--custom-api-key");
    expect(apiKeyParams?.envVar).toBe("CUSTOM_API_KEY");
    expect(apiKeyParams?.envVarName).toBe("CUSTOM_API_KEY");
    expect(apiKeyParams?.agentDir).toBe(target.agentDir);
    expect(apiKeyParams?.secretInputMode).toBe("ref");
  });

  it.each([
    { name: "explicit model", modelId: "local-large", apiKey: undefined, persisted: false },
    { name: "saved inline key", modelId: undefined, apiKey: "fixture-saved-key", persisted: false },
    {
      name: "persisted policy with inline key",
      modelId: undefined,
      apiKey: "fixture-saved-key",
      persisted: true,
    },
    {
      name: "persisted policy with unresolved SecretRef",
      modelId: undefined,
      apiKey: { source: "env", provider: "default", id: "UNRESOLVED_DISCOVERY_KEY" },
      persisted: true,
    },
    {
      name: "unresolved SecretRef",
      persisted: false,
      modelId: undefined,
      apiKey: { source: "env", provider: "default", id: "UNRESOLVED_DISCOVERY_KEY" },
    },
  ] as const)(
    "skips credentials for custom no-auth with $name",
    async ({ modelId, apiKey, persisted }) => {
      vi.stubEnv("CUSTOM_API_KEY", undefined);
      vi.stubEnv("UNRESOLVED_DISCOVERY_KEY", undefined);
      resolveNonInteractiveApiKey.mockResolvedValueOnce(
        persisted
          ? null
          : {
              key: "ambient-env-key-must-be-ignored",
              source: "env",
              envVarName: "CUSTOM_API_KEY",
            },
      );
      const authorizationHeaders: Array<string | null> = [];
      const request = vi
        .spyOn(fetchGuard, "fetchWithSsrFGuard")
        .mockImplementation(async (input) => {
          const authorization = new Headers(input.init?.headers).get("authorization");
          authorizationHeaders.push(authorization);
          return {
            response: authorization
              ? new Response(null, { status: 401 })
              : Response.json({ data: [{ id: "discovered-chat" }] }),
            finalUrl: input.url,
            release: async () => {},
          };
        });

      const result = await applyChoice({
        nextConfig: {
          models: {
            providers: {
              local: {
                baseUrl: "https://models.custom.local/v1",
                apiKey,
                ...(persisted ? { auth: "none" as const } : {}),
                models: [],
              },
            },
          },
        },
        opts: {
          customBaseUrl: "https://models.custom.local/v1",
          customProviderId: "local",
          customModelId: modelId,
          customNoAuth: !persisted,
        },
      });

      expect(authorizationHeaders).toEqual(modelId ? [] : [null]);
      expect(request).toHaveBeenCalledTimes(modelId ? 0 : 1);
      expect(result?.models?.providers?.local).toMatchObject({
        auth: "none",
        models: [expect.objectContaining({ id: modelId ?? "discovered-chat" })],
      });
      expect(result?.models?.providers?.local?.apiKey).toEqual(persisted ? apiKey : undefined);
      expect(resolveNonInteractiveApiKey).not.toHaveBeenCalled();
      expect(runtime.error).not.toHaveBeenCalled();
    },
  );

  it("never commits an existing profile key as plaintext during custom secret-ref onboarding", async () => {
    const profileKey = "fixture-custom-profile-secret";
    resolveNonInteractiveApiKey.mockResolvedValueOnce({ key: profileKey, source: "profile" });

    const result = await applyChoice({
      nextConfig,
      opts: {
        customBaseUrl: "https://models.custom.local/v1",
        customModelId: "local-large",
        secretInputMode: "ref",
      } as never,
    });

    expect(result).not.toBeNull();
    await commitNonInteractiveOnboardConfig({
      nextConfig: result!,
      baseConfig: nextConfig,
    });

    const persistedConfig = writeWizardConfigFile.mock.calls.at(-1)?.[0];
    expect(
      persistedConfig?.models?.providers?.["custom-models-custom-local"]?.apiKey,
    ).toBeUndefined();
    expect(JSON.stringify(persistedConfig)).not.toContain(profileKey);
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it.each([
    { source: "flag", key: "fixture-custom-literal-secret" },
    { source: "env", key: "fixture-custom-anonymous-env-secret" },
  ] as const)(
    "never serializes an unreferenceable custom $source key in secret-ref mode",
    async (resolved) => {
      resolveNonInteractiveApiKey.mockResolvedValueOnce(resolved);

      const result = await applyChoice({
        nextConfig,
        opts: {
          customBaseUrl: "https://models.custom.local/v1",
          customModelId: "local-large",
          secretInputMode: "ref",
        } as never,
      });

      expect(result).toBeNull();
      expect(writeWizardConfigFile).not.toHaveBeenCalled();
      expect(runtime.exit).toHaveBeenCalledWith(1);
      const errorText = runtime.error.mock.calls.map(([message]) => String(message)).join("\n");
      expect(errorText).toContain("CUSTOM_API_KEY");
      expect(errorText).toContain("--secret-input-mode ref");
      expect(errorText).not.toContain(resolved.key);
    },
  );

  it("does not reformat an already-reported custom auth rejection", async () => {
    resolveNonInteractiveApiKey.mockResolvedValueOnce({ key: "fixture-key", source: "flag" });
    const exit = new ExitError(1);
    runtime.exit.mockImplementation(() => {
      throw exit;
    });
    await expect(
      applyChoice({
        opts: {
          customBaseUrl: "https://models.custom.local/v1",
          customModelId: "local-large",
          secretInputMode: "ref",
          json: true,
        },
      }),
    ).rejects.toBe(exit);
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
    const profileConfig = {
      models: {
        providers: {
          [providerId]: {
            baseUrl: "https://models.custom.local/v1",
            apiKey: ref,
            models: [],
          },
        },
      },
    } as OpenClawConfig;
    resolveNonInteractiveApiKey.mockResolvedValueOnce({
      key: "fixture-existing-profile-secret",
      source: "profile",
    });

    const result = await applyChoice({
      nextConfig: profileConfig,
      opts: {
        customBaseUrl: "https://models.custom.local/v1",
        customModelId: "local-large",
        secretInputMode: "ref",
      } as never,
    });

    expect(result?.models?.providers?.[providerId]?.apiKey).toEqual(ref);
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("preserves intentionally keyless custom setup in secret-ref mode", async () => {
    resolveNonInteractiveApiKey.mockResolvedValueOnce(null);

    const result = await applyChoice({
      nextConfig,
      opts: {
        customBaseUrl: "https://models.custom.local/v1",
        customModelId: "local-large",
        secretInputMode: "ref",
      } as never,
    });

    expect(result?.models?.providers?.["custom-models-custom-local"]?.apiKey).toBeUndefined();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("preserves existing custom profile serialization in explicit plaintext mode", async () => {
    resolveNonInteractiveApiKey.mockResolvedValueOnce({
      key: "fixture-plaintext-profile-key",
      source: "profile",
    });

    const result = await applyChoice({
      nextConfig,
      opts: {
        customBaseUrl: "https://models.custom.local/v1",
        customModelId: "local-large",
        secretInputMode: "plaintext",
      } as never,
    });

    expect(result?.models?.providers?.["custom-models-custom-local"]?.apiKey).toBe(
      "fixture-plaintext-profile-key",
    );
  });

  it.each([
    { source: "profile", key: "fixture-plugin-profile-secret" },
    { source: "env", key: "fixture-plugin-env-secret" },
  ] as const)(
    "rejects non-referenceable $source plugin credentials in secret-ref mode",
    async (resolved) => {
      applyNonInteractivePluginProviderChoice.mockResolvedValueOnce(nextConfig as never);

      await applyChoice({
        nextConfig,
        authChoice: "demo-provider-api-key",
        opts: { secretInputMode: "ref" } as never,
      });

      const [pluginParams] = applyNonInteractivePluginProviderChoice.mock.calls.at(
        -1,
      ) as unknown as [
        {
          toApiKeyCredential: (params: { provider: string; resolved: typeof resolved }) => unknown;
        },
      ];
      const credential = pluginParams.toApiKeyCredential({
        provider: "demo-provider",
        resolved,
      });

      expect(credential).toBeNull();
      expect(runtime.exit).toHaveBeenCalledWith(1);
      const errorText = runtime.error.mock.calls.map(([message]) => String(message)).join("\n");
      expect(errorText).toContain("--secret-input-mode ref");
      expect(errorText).toContain("demo-provider");
      expect(errorText).not.toContain(resolved.key);
    },
  );

  it("preserves env-backed plugin credentials and profile metadata in secret-ref mode", async () => {
    applyNonInteractivePluginProviderChoice.mockResolvedValueOnce(nextConfig as never);

    await applyChoice({
      nextConfig,
      authChoice: "demo-provider-api-key",
      opts: { secretInputMode: "ref" } as never,
    });

    const [pluginParams] = applyNonInteractivePluginProviderChoice.mock.calls.at(-1) as unknown as [
      {
        toApiKeyCredential: (params: {
          provider: string;
          resolved: { key: string; source: "env"; envVarName: string };
          email: string;
          metadata: Record<string, string>;
        }) => unknown;
      },
    ];
    expect(
      pluginParams.toApiKeyCredential({
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
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("infers image-capable non-interactive custom provider models by known model id", async () => {
    resolveNonInteractiveApiKey.mockResolvedValueOnce(undefined);

    const result = await applyChoice({
      nextConfig,
      opts: {
        customBaseUrl: "https://models.custom.local/v1",
        customModelId: "gpt-4o",
      } as never,
    });

    expect(result?.models?.providers?.["custom-models-custom-local"]?.models?.[0]?.input).toEqual([
      "text",
      "image",
    ]);
  });

  it("honors explicit text-only override for known custom vision models", async () => {
    resolveNonInteractiveApiKey.mockResolvedValueOnce(undefined);

    const result = await applyChoice({
      nextConfig,
      opts: {
        customBaseUrl: "https://models.custom.local/v1",
        customModelId: "gpt-4o",
        customImageInput: false,
      } as never,
    });

    expect(result?.models?.providers?.["custom-models-custom-local"]?.models?.[0]?.input).toEqual([
      "text",
    ]);
  });

  it.each([
    {
      name: "warns before dispatching a manifest replacement",
      authChoice: "claude-cli",
      hasReplacement: true,
      expectedError: undefined,
    },
    {
      name: "keeps direct oauth as an unknown choice",
      authChoice: "oauth",
      hasReplacement: true,
      expectedError:
        'Unknown --auth-choice "oauth". Valid choices: custom-api-key, skip, demo-provider-api-key.',
    },
    {
      name: "rejects the original alias when replacement metadata is missing",
      authChoice: "claude-cli",
      hasReplacement: false,
      expectedError:
        'Unknown --auth-choice "claude-cli". Valid choices: custom-api-key, skip, demo-provider-api-key.',
    },
  ])("$name", async ({ authChoice, hasReplacement, expectedError }) => {
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

    const result = await applyChoice({
      nextConfig,
      authChoice,
      opts: {},
    });

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
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
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
