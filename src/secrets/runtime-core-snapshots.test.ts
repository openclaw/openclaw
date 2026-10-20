import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAuthProfileStore } from "../agents/auth-profiles.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { resolveConfigForRead } from "../config/io.read-helpers.js";
import {
  getAuthoredConfigSecretRef,
  setConfigResolutionFacts,
} from "../config/resolution-facts.js";
import type { SecretRef } from "../config/types.secrets.js";
import { registerEmbeddingProvider } from "../plugins/embedding-providers.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { captureEnv } from "../test-utils/env.js";
import { assertSecretOwnerAvailable } from "./runtime-degraded-state.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "./runtime.js";
import {
  asConfig,
  buildTestWebSearchProviders,
  loadAuthStoreWithProfiles,
  resetPluginWebSearchProvidersMock,
} from "./runtime.test-support.ts";

const { resolveExternalAuthProfilesWithPluginsMock, resolvePluginWebSearchProvidersMock } =
  vi.hoisted(() => ({
    resolveExternalAuthProfilesWithPluginsMock: vi.fn(() => []),
    resolvePluginWebSearchProvidersMock: vi.fn(() => buildTestWebSearchProviders()),
  }));

vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: resolvePluginWebSearchProvidersMock,
}));

// mock-isolation: Secret snapshot fixtures supply external-profile results and must not read real provider credentials.
vi.mock("../plugins/provider-external-auth-core.js", () => ({
  createProviderExternalAuthResolver: () => ({
    resolveExternalAuthProfilesWithPlugins: resolveExternalAuthProfilesWithPluginsMock,
    withPreparedExternalAuthProfiles: async <T>(_params: unknown, run: () => Promise<T>) => run(),
  }),
}));

const envRef = (id: string) => ({ source: "env", provider: "default", id }) as const;
const OPENAI_ENV_KEY_REF = envRef("OPENAI_API_KEY");
const agentDir = "/tmp/openclaw-agent-main";
const providerConfig = (apiKey: string | SecretRef) => ({
  baseUrl: "https://api.openai.com/v1",
  apiKey,
  models: [],
});
const openAiConfig = (apiKey: string | SecretRef) =>
  asConfig({ models: { providers: { openai: providerConfig(apiKey) } } });
type PrepareParams = Parameters<typeof prepareSecretsRuntimeSnapshot>[0];
function prepare(params: PrepareParams) {
  return prepareSecretsRuntimeSnapshot({ loadablePluginOrigins: new Map(), ...params });
}
function prepareProfiles(
  profiles: Parameters<typeof loadAuthStoreWithProfiles>[0],
  params: Partial<PrepareParams> = {},
) {
  return prepare({
    config: asConfig({}),
    env: { OPENAI_API_KEY: "sk-env-openai" },
    agentDirs: [agentDir],
    loadAuthStore: () => loadAuthStoreWithProfiles(profiles),
    ...params,
  });
}

describe("secrets runtime snapshot core lanes", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv([
      "OPENCLAW_BUNDLED_PLUGINS_DIR",
      "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
      "OPENCLAW_VERSION",
    ]);
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    delete process.env.OPENCLAW_VERSION;
    resolveExternalAuthProfilesWithPluginsMock.mockReset();
    resolveExternalAuthProfilesWithPluginsMock.mockReturnValue([]);
    resetPluginWebSearchProvidersMock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    envSnapshot.restore();
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearSecretsRuntimeSnapshot();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
  });

  it("resolves config env refs for core config surfaces", async () => {
    const snapshot = await prepare({
      config: asConfig({
        models: {
          providers: {
            openai: {
              ...providerConfig(OPENAI_ENV_KEY_REF),
              headers: { Authorization: envRef("OPENAI_PROVIDER_AUTH_HEADER") },
            },
          },
        },
        skills: {
          entries: {
            "review-pr": {
              enabled: true,
              apiKey: envRef("REVIEW_SKILL_API_KEY"),
            },
          },
        },
      }),
      env: {
        OPENAI_API_KEY: "sk-env-openai",
        OPENAI_PROVIDER_AUTH_HEADER: "Bearer sk-env-header",
        REVIEW_SKILL_API_KEY: "sk-skill-ref",
      },
      includeAuthStoreRefs: false,
    });

    expect(snapshot.config.models?.providers?.openai).toMatchObject({
      apiKey: "sk-env-openai",
      headers: { Authorization: "Bearer sk-env-header" },
    });
    expect(snapshot.config.skills?.entries?.["review-pr"]?.apiKey).toBe("sk-skill-ref");
  });

  it.each([
    ["$SOURCE", {}, { SOURCE: "${OTHER}" }, true],
    ["${SOURCE}", { SOURCE: "${OTHER}" }, {}, false],
    ["$${OTHER}", {}, {}, false],
  ] as const)(
    "materializes authored provider credential %s without reinterpreting literals",
    async (authored, sourceEnv, runtimeEnv, pendingSourceRef) => {
      const read = resolveConfigForRead(openAiConfig(authored), sourceEnv);
      const config = asConfig(read.resolvedConfigRaw);
      setConfigResolutionFacts(config, read.resolutionFacts);

      const snapshot = await prepare({
        config,
        env: runtimeEnv,
        includeAuthStoreRefs: false,
      });
      const keyPath = "models.providers.openai.apiKey";
      expect(snapshot.config.models?.providers?.openai?.apiKey).toBe("${OTHER}");
      expect(getAuthoredConfigSecretRef(snapshot.sourceConfig, keyPath) !== null).toBe(
        pendingSourceRef,
      );
      expect(getAuthoredConfigSecretRef(snapshot.config, keyPath)).toBeNull();
    },
  );

  it("resolves env refs for memory, talk, and gateway surfaces", async () => {
    const snapshot = await prepare({
      config: asConfig({
        memory: { search: { remote: { apiKey: envRef("MEMORY_REMOTE_API_KEY") } } },
        agents: { defaults: {} },
        talk: { providers: { "acme-speech": { apiKey: envRef("TALK_PROVIDER_API_KEY") } } },
        gateway: {
          mode: "remote",
          remote: {
            url: "wss://gateway.example",
            token: envRef("REMOTE_GATEWAY_TOKEN"),
            password: envRef("REMOTE_GATEWAY_PASSWORD"),
          },
        },
      }),
      env: {
        MEMORY_REMOTE_API_KEY: "mem-ref-key",
        TALK_PROVIDER_API_KEY: "talk-provider-ref-key",
        REMOTE_GATEWAY_TOKEN: "remote-token-ref",
        REMOTE_GATEWAY_PASSWORD: "remote-password-ref",
      },
      includeAuthStoreRefs: false,
    });

    expect(snapshot.config.memory?.search?.remote?.apiKey).toBe("mem-ref-key");
    expect((snapshot.config.talk as { apiKey?: unknown } | undefined)?.apiKey).toBeUndefined();
    expect(snapshot.config.talk?.providers?.["acme-speech"]?.apiKey).toBe("talk-provider-ref-key");
    expect(snapshot.config.gateway?.remote).toMatchObject({
      token: "remote-token-ref",
      password: "remote-password-ref",
    });
  });

  it.each([
    ["gemini", "google", "tenant-gemini", true],
    ["gemini", "google", "gemini", false],
  ] as const)(
    "binds %s memory credentials to %s (configured=%s, metadata=%s)",
    async (adapterId, authProviderId, configuredProviderId, registryMetadata) => {
      const apiKeyRef = envRef("MEMORY_REMOTE_KEY");
      const manifest: PluginManifestRecord = {
        id: authProviderId,
        origin: "bundled",
        rootDir: "/test-plugin",
        source: "/test-plugin/index.ts",
        manifestPath: "/test-plugin/openclaw.plugin.json",
        channels: [],
        providers: [`${authProviderId}-secondary`, authProviderId],
        cliBackends: [],
        skills: [],
        hooks: [],
        contracts: { embeddingProviders: [adapterId] },
      };
      const prepareMemory = (version: "old" | "new", env: NodeJS.ProcessEnv) =>
        prepareSecretsRuntimeSnapshot({
          config: asConfig({
            agents: { entries: { main: {} } },
            memory: {
              search: {
                ...(configuredProviderId ? { provider: configuredProviderId } : {}),
                remote: { apiKey: apiKeyRef },
              },
            },
            models: {
              providers: {
                [authProviderId]: {
                  baseUrl: `https://${version}.example.invalid/v1`,
                  headers: { "X-Tenant": version },
                  models: [],
                },
                ...(configuredProviderId && configuredProviderId !== adapterId
                  ? {
                      [configuredProviderId]: {
                        api: adapterId,
                        baseUrl: "https://tenant.example.invalid/v1",
                        headers: { "X-Custom-Tenant": "configured" },
                        models: [],
                      },
                    }
                  : {}),
              },
            },
          }),
          env,
          includeAuthStoreRefs: false,
          allowUnavailableSecretOwners: true,
          loadablePluginOrigins: new Map(),
          ...(registryMetadata ? { manifestRegistry: { plugins: [manifest] } } : {}),
        });
      const active = await prepareMemory("old", { MEMORY_REMOTE_KEY: "last-known-good" });
      activateSecretsRuntimeSnapshot(active);

      if (registryMetadata) {
        registerEmbeddingProvider(
          { id: adapterId, authProviderId, create: async () => ({ provider: null }) },
          { ownerPluginId: authProviderId },
        );
      }

      const unchanged = await prepareMemory("old", {});
      const changed = await prepareMemory("new", {});

      expect(unchanged.config.memory?.search?.remote?.apiKey).toBe("last-known-good");
      expect(unchanged.degradedOwners).toMatchObject([
        { ownerKind: "capability", ownerId: "memory-provider:main", degradationState: "stale" },
      ]);
      expect(changed.config.memory?.search?.remote?.apiKey).toEqual(apiKeyRef);
      expect(changed.degradedOwners).toMatchObject([
        { ownerKind: "capability", ownerId: "memory-provider:main", degradationState: "cold" },
      ]);

      activateSecretsRuntimeSnapshot(changed);
      expect(() => assertSecretOwnerAvailable("capability", "memory-provider:main")).toThrow(
        expect.objectContaining({
          code: "SECRET_SURFACE_UNAVAILABLE",
          ownerId: "memory-provider:main",
        }),
      );
    },
  );

  it("resolves env-backed auth profile SecretRefs", async () => {
    const snapshot = await prepareProfiles(
      {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "old-openai",
          keyRef: OPENAI_ENV_KEY_REF,
        },
        "github-copilot:default": {
          type: "token",
          provider: "github-copilot",
          token: "old-gh",
          tokenRef: envRef("GITHUB_TOKEN"),
        },
        "openai:literal": { type: "api_key", provider: "openai", key: "literal-key" },
        "custom:literal": { type: "token", provider: "custom", token: "literal-token" },
        "custom:expired": {
          type: "token",
          provider: "custom",
          expires: 1,
          tokenRef: envRef("FIXTURE_EXPIRED_TOKEN"),
        },
      },
      { env: { OPENAI_API_KEY: "sk-env-openai", GITHUB_TOKEN: "ghp-env-token" } },
    );

    expect(snapshot.warnings).toEqual([
      {
        code: "SECRETS_REF_OVERRIDES_PLAINTEXT",
        path: "/tmp/openclaw-agent-main.auth-profiles.openai:default.key",
        message: "auth-profiles openai:default: keyRef is set; runtime will ignore plaintext key.",
      },
      {
        code: "SECRETS_REF_OVERRIDES_PLAINTEXT",
        path: "/tmp/openclaw-agent-main.auth-profiles.github-copilot:default.token",
        message:
          "auth-profiles github-copilot:default: tokenRef is set; runtime will ignore plaintext token.",
      },
      {
        code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
        path: "/tmp/openclaw-agent-main.auth-profiles.custom:expired.token",
        message:
          "/tmp/openclaw-agent-main.auth-profiles.custom:expired.token: auth profile is not eligible (expired); skipping resolution until it becomes eligible.",
      },
    ]);
    expect(snapshot.authStores[0]?.store.profiles).toMatchObject({
      "openai:default": { type: "api_key", key: "sk-env-openai" },
      "github-copilot:default": { type: "token", token: "ghp-env-token" },
      "openai:literal": { key: "literal-key" },
      "custom:literal": { token: "literal-token" },
    });
    expect(snapshot.authStores[0]?.store.profiles["custom:expired"]).not.toHaveProperty("token");
    expect(snapshot.degradedOwners).toEqual([]);
  });

  it("can materialize auth stores without resolving unrelated config refs", async () => {
    const resolvedApiKey = "test-auth-profile-value";
    const apiKeyRef = envRef("UNRELATED_PROVIDER_KEY");
    const config = openAiConfig(apiKeyRef);
    const snapshot = await prepareProfiles(
      { "openai:default": { type: "api_key", provider: "openai", keyRef: OPENAI_ENV_KEY_REF } },
      {
        config,
        assignmentConfig: config,
        env: { OPENAI_API_KEY: resolvedApiKey },
        includeConfigRefs: false,
      },
    );

    expect(snapshot.config.models?.providers?.openai?.apiKey).toEqual(apiKeyRef);
    expect(snapshot.authStores[0]?.store.profiles["openai:default"]).toMatchObject({
      key: resolvedApiKey,
    });
  });

  it("resolves inline placeholder auth profiles to env refs", async () => {
    const snapshot = await prepareProfiles({
      "openai:inline": {
        type: "api_key",
        provider: "openai",
        key: "${OPENAI_API_KEY}",
      },
    });

    expect(snapshot.authStores[0]?.store.profiles["openai:inline"]).toMatchObject({
      type: "api_key",
      key: "sk-env-openai",
    });
    expect(snapshot.authStores[0]?.store.profiles["openai:inline"]).toHaveProperty(
      "keyRef",
      OPENAI_ENV_KEY_REF,
    );
  });

  it("activates runtime snapshots for ensureAuthProfileStore", async () => {
    const prepared = await prepareProfiles(
      {
        "openai:default": { type: "api_key", provider: "openai", keyRef: OPENAI_ENV_KEY_REF },
      },
      { config: openAiConfig(OPENAI_ENV_KEY_REF), env: { OPENAI_API_KEY: "sk-runtime" } },
    );
    activateSecretsRuntimeSnapshot(prepared);

    expect(ensureAuthProfileStore(agentDir).profiles["openai:default"]).toMatchObject({
      type: "api_key",
      key: "sk-runtime",
    });
  });
});
