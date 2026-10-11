import type { execSync } from "node:child_process";
// Provider auth tests cover credential resolution, setup state, and auth method contracts.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
} from "../agents/auth-profiles.js";
import type { AuthProfileCredential, AuthProfileStore } from "../agents/auth-profiles/types.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isProviderApiKeyConfigured,
  normalizeGithubCopilotDomain,
  readClaudeCliCredentialsCached,
} from "./provider-auth.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function claudeCredentialJson(
  accessToken: string,
  refreshToken: string,
  subscriptionType?: string,
) {
  return JSON.stringify({
    claudeAiOauth: { accessToken, refreshToken, expiresAt: 1_800_000_000_000, subscriptionType },
  });
}

describe("provider auth public SDK", () => {
  it("keeps the shipped Claude credential reader functional during its deprecation window", async () => {
    const homeDir = tempDirs.make("openclaw-sdk-claude-auth-");
    const credentialsDir = path.join(homeDir, ".claude");
    await fs.mkdir(credentialsDir, { recursive: true });
    await fs.writeFile(
      path.join(credentialsDir, ".credentials.json"),
      claudeCredentialJson("legacy-access", "legacy-refresh", "max"),
    );

    expect(readClaudeCliCredentialsCached({ homeDir, platform: "linux", ttlMs: 0 })).toEqual({
      type: "oauth",
      provider: "anthropic",
      access: "legacy-access",
      refresh: "legacy-refresh",
      expires: 1_800_000_000_000,
      subscriptionType: "max",
    });
  });

  it("reads Claude credentials from CLAUDE_CONFIG_DIR", async () => {
    const configDir = tempDirs.make("openclaw-sdk-claude-config-");
    await fs.writeFile(
      path.join(configDir, ".credentials.json"),
      claudeCredentialJson("configured-access", "configured-refresh"),
    );
    await fs.writeFile(
      path.join(configDir, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "configured@example.com" } }),
    );
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);

    try {
      expect(readClaudeCliCredentialsCached({ platform: "linux", ttlMs: 0 })).toMatchObject({
        type: "oauth",
        access: "configured-access",
        refresh: "configured-refresh",
        email: "configured@example.com",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not attach shared config identity to split-store credentials", async () => {
    const configDir = tempDirs.make("openclaw-sdk-claude-config-split-");
    const secureStorageDir = tempDirs.make("openclaw-sdk-claude-secure-storage-");
    await fs.writeFile(
      path.join(secureStorageDir, ".credentials.json"),
      claudeCredentialJson("secure-storage-access", "secure-storage-refresh"),
    );
    await fs.writeFile(
      path.join(configDir, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "configured@example.com" } }),
    );
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", secureStorageDir);

    try {
      const credential = readClaudeCliCredentialsCached({ platform: "linux", ttlMs: 0 });
      expect(credential).toMatchObject({
        access: "secure-storage-access",
        refresh: "secure-storage-refresh",
      });
      expect(credential).not.toHaveProperty("email");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("isolates cached config metadata when profiles share secure storage", async () => {
    const firstConfigDir = tempDirs.make("openclaw-sdk-claude-first-config-");
    const secondConfigDir = tempDirs.make("openclaw-sdk-claude-second-config-");
    const secureStorageDir = tempDirs.make("openclaw-sdk-claude-shared-storage-");
    const firstHelper = "first-profile-helper";
    const secondHelper = "second-profile-helper";
    const firstSettingsPath = path.join(firstConfigDir, "settings.json");
    const secondSettingsPath = path.join(secondConfigDir, "settings.json");
    await fs.writeFile(firstSettingsPath, JSON.stringify({ apiKeyHelper: firstHelper }));
    await fs.writeFile(secondSettingsPath, JSON.stringify({ apiKeyHelper: secondHelper }));
    const sharedMtime = new Date(1_800_000_000_000);
    await fs.utimes(firstSettingsPath, sharedMtime, sharedMtime);
    await fs.utimes(secondSettingsPath, sharedMtime, sharedMtime);
    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", secureStorageDir);

    try {
      vi.stubEnv("CLAUDE_CONFIG_DIR", firstConfigDir);
      expect(readClaudeCliCredentialsCached({ platform: "linux", ttlMs: 60_000 })).toEqual({
        type: "api_key_helper",
        provider: "anthropic",
        helperHash: createHash("sha256").update(firstHelper).digest("hex"),
      });

      vi.stubEnv("CLAUDE_CONFIG_DIR", secondConfigDir);
      expect(readClaudeCliCredentialsCached({ platform: "linux", ttlMs: 60_000 })).toEqual({
        type: "api_key_helper",
        provider: "anthropic",
        helperHash: createHash("sha256").update(secondHelper).digest("hex"),
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("pins an empty secure-storage override to the default credential store", async () => {
    const osHome = tempDirs.make("openclaw-sdk-claude-default-home-");
    const defaultCredentialsDir = path.join(osHome, ".claude");
    const configDir = tempDirs.make("openclaw-sdk-claude-other-config-");
    await fs.mkdir(defaultCredentialsDir, { recursive: true });
    await fs.writeFile(
      path.join(defaultCredentialsDir, ".credentials.json"),
      claudeCredentialJson("default-store-access", "default-store-refresh"),
    );
    vi.stubEnv("HOME", osHome);
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", "");

    try {
      expect(readClaudeCliCredentialsCached({ platform: "linux", ttlMs: 0 })).toMatchObject({
        access: "default-store-access",
        refresh: "default-store-refresh",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reads the macOS Keychain through the absolute system executable", () => {
    const execSyncImpl = vi.fn((command: string) => {
      expect(command).toMatch(/^\/usr\/bin\/security find-generic-password /u);
      expect(command).toContain('-a "test-user"');
      return claudeCredentialJson("keychain-access", "keychain-refresh");
    }) as unknown as typeof execSync;

    vi.stubEnv("USER", "test-user");
    try {
      expect(
        readClaudeCliCredentialsCached({
          execSync: execSyncImpl,
          platform: "darwin",
          tryKeychainWithoutPrompt: true,
          ttlMs: 0,
        }),
      ).toMatchObject({ type: "oauth", access: "keychain-access" });
      expect(execSyncImpl).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not impose a machine timeout on prompt-enabled Keychain reads", () => {
    const execSyncImpl = vi.fn((_command: string, options: { timeout?: number }) => {
      expect(options).not.toHaveProperty("timeout");
      return claudeCredentialJson("prompted-access", "prompted-refresh");
    }) as unknown as typeof execSync;

    expect(
      readClaudeCliCredentialsCached({
        allowKeychainPrompt: true,
        execSync: execSyncImpl,
        platform: "darwin",
        ttlMs: 0,
      }),
    ).toMatchObject({ type: "oauth", access: "prompted-access" });
    expect(execSyncImpl).toHaveBeenCalledOnce();
  });

  it("selects and caches the macOS Keychain service by secure-storage config", () => {
    const firstDir = "/tmp/claude-secure-one";
    const secondDir = "/tmp/claude-secure-two";
    const serviceFor = (configDir: string) =>
      `Claude Code-credentials-${createHash("sha256").update(configDir).digest("hex").slice(0, 8)}`;
    const execSyncImpl = vi.fn((command: string) =>
      JSON.stringify({
        claudeAiOauth: {
          accessToken: command.includes(serviceFor(firstDir)) ? "first-access" : "second-access",
          refreshToken: "keychain-refresh",
          expiresAt: 1_800_000_000_000,
        },
      }),
    ) as unknown as typeof execSync;

    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", firstDir);
    expect(
      readClaudeCliCredentialsCached({
        execSync: execSyncImpl,
        platform: "darwin",
        ttlMs: 60_000,
      }),
    ).toMatchObject({ access: "first-access" });

    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", secondDir);
    expect(
      readClaudeCliCredentialsCached({
        execSync: execSyncImpl,
        platform: "darwin",
        ttlMs: 60_000,
      }),
    ).toMatchObject({ access: "second-access" });
    expect(execSyncImpl).toHaveBeenCalledTimes(2);
    expect(execSyncImpl).toHaveBeenLastCalledWith(
      expect.stringContaining(serviceFor(secondDir)),
      expect.any(Object),
    );
    vi.unstubAllEnvs();
  });

  it("keeps explicit no-prompt macOS Keychain reads presence-only", () => {
    const execSyncImpl = vi.fn((command: string) => {
      expect(command).toMatch(/^\/usr\/bin\/security find-generic-password /u);
      expect(command).not.toContain(" -w");
      return "keychain metadata";
    }) as unknown as typeof execSync;
    const onStoredCredentialUnreadable = vi.fn();

    expect(
      readClaudeCliCredentialsCached({
        allowKeychainPrompt: false,
        execSync: execSyncImpl,
        platform: "darwin",
        tryKeychainWithoutPrompt: true,
        onStoredCredentialUnreadable,
        ttlMs: 0,
      }),
    ).toBeNull();
    expect(execSyncImpl).toHaveBeenCalledOnce();
    expect(onStoredCredentialUnreadable).toHaveBeenCalledOnce();
  });

  it("does not reuse a no-prompt Keychain miss for a prompt-enabled read", () => {
    const homeDir = tempDirs.make("openclaw-sdk-claude-keychain-cache-");
    const execSyncImpl = vi.fn((command: string) =>
      command.includes(" -w")
        ? claudeCredentialJson("prompted-access", "prompted-refresh")
        : "keychain metadata",
    ) as unknown as typeof execSync;

    expect(
      readClaudeCliCredentialsCached({
        allowKeychainPrompt: false,
        execSync: execSyncImpl,
        homeDir,
        platform: "darwin",
        tryKeychainWithoutPrompt: true,
        ttlMs: 60_000,
      }),
    ).toBeNull();
    expect(
      readClaudeCliCredentialsCached({
        allowKeychainPrompt: true,
        execSync: execSyncImpl,
        homeDir,
        platform: "darwin",
        tryKeychainWithoutPrompt: true,
        ttlMs: 60_000,
      }),
    ).toMatchObject({ type: "oauth", access: "prompted-access" });
    expect(execSyncImpl).toHaveBeenCalledOnce();
    expect(execSyncImpl).toHaveBeenCalledWith(expect.stringContaining(" -w"), expect.any(Object));
  });

  it("does not reuse a silent malformed-file miss for a diagnostic read", async () => {
    const homeDir = tempDirs.make("openclaw-sdk-claude-unreadable-cache-");
    const credentialsDir = path.join(homeDir, ".claude");
    await fs.mkdir(credentialsDir, { recursive: true });
    await fs.writeFile(path.join(credentialsDir, ".credentials.json"), "{}\n");
    const onStoredCredentialUnreadable = vi.fn();

    expect(
      readClaudeCliCredentialsCached({ homeDir, platform: "linux", ttlMs: 60_000 }),
    ).toBeNull();
    expect(
      readClaudeCliCredentialsCached({
        homeDir,
        onStoredCredentialUnreadable,
        platform: "linux",
        tryKeychainWithoutPrompt: true,
        ttlMs: 60_000,
      }),
    ).toBeNull();
    expect(onStoredCredentialUnreadable).toHaveBeenCalledOnce();
  });
});

type FallbackStoreCaseResult = {
  profileIds: string[];
  resolvedKey: string | undefined;
  resolveApiKeyCalls: unknown[][];
};

async function runFallbackStoreCase(): Promise<FallbackStoreCaseResult> {
  vi.resetModules();

  const primaryStore: AuthProfileStore = {
    version: 1,
    profiles: {},
  };
  const fallbackStore: AuthProfileStore = {
    version: 1,
    profiles: {
      "openai:default": {
        type: "api_key",
        provider: "openai",
        key: "fallback-key",
      },
    },
  };
  const resolveApiKeyForProfile = vi.fn(
    async (params: { store: AuthProfileStore; profileId: string }) => {
      const profile = params.store.profiles[params.profileId];
      return profile?.type === "api_key" && profile.key
        ? {
            apiKey: profile.key,
            provider: profile.provider,
            profileId: params.profileId,
            profileType: profile.type,
          }
        : null;
    },
  );

  vi.doMock("../agents/agent-scope-config.js", async () => {
    const { resolveAgentDir } = await vi.importActual<
      typeof import("../agents/agent-scope-config.js")
    >("../agents/agent-scope-config.js");
    return { resolveAgentDir, resolveDefaultAgentDir: () => "/tmp/openclaw-agent" };
  });
  vi.doMock("../agents/auth-profiles/oauth.js", () => ({
    resolveApiKeyForProfile,
  }));
  vi.doMock("../agents/auth-profiles/order.js", () => ({
    resolveAuthProfileOrder: ({ provider, store }: { provider: string; store: AuthProfileStore }) =>
      Object.entries(store.profiles)
        .filter(([, profile]) => profile.provider === provider)
        .map(([profileId]) => profileId),
  }));
  // mock-isolation: Profile-list tests use synthetic primary and fallback store snapshots.
  vi.doMock("../plugins/provider-auth-availability.js", async () => {
    const { createProviderAuthAvailability } =
      await import("../plugins/provider-auth-availability-core.js");
    const { findPersistedAuthProfileCredential } = await import("../agents/auth-profiles/store.js");
    const { findPersistedAuthProfileCredentialAsync } =
      await import("../agents/auth-profiles/store-runtime.js");
    return createProviderAuthAvailability({
      findPersistedAuthProfileCredential,
      findPersistedAuthProfileCredentialAsync,
      ensureAuthProfileStore: vi.fn(() => primaryStore),
      ensureAuthProfileStoreAsync: vi.fn(async () => primaryStore),
      loadAuthProfileStoreWithoutExternalProfilesAsync: vi.fn(async () => fallbackStore),
      loadAuthProfileStoreForRuntimeAsync: vi.fn(async () => primaryStore),
      loadAuthProfileStoreForSecretsRuntime: vi.fn(() => primaryStore),
      loadAuthProfileStoreWithoutExternalProfiles: vi.fn(() => fallbackStore),
    });
  });

  const { listUsableProviderAuthProfileIds, resolveProviderAuthProfileApiKey } =
    await import("./provider-auth.js");

  return {
    profileIds: listUsableProviderAuthProfileIds({ provider: "openai" }).profileIds,
    resolvedKey: await resolveProviderAuthProfileApiKey({ provider: "openai" }),
    resolveApiKeyCalls: resolveApiKeyForProfile.mock.calls,
  };
}

describe("provider API-key readiness", () => {
  const provider = "media-readiness-provider";

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    clearRuntimeAuthProfileStoreSnapshots();
    vi.unstubAllEnvs();
  });

  function configuredProvider(apiKey: unknown, providerId = provider): OpenClawConfig {
    return {
      models: {
        providers: {
          [providerId]: {
            apiKey,
            baseUrl: "https://media.example.test/v1",
            models: [],
          },
        },
      },
    } as OpenClawConfig;
  }

  it("recognizes usable config-only API keys for normalized provider entries", () => {
    expect(
      isProviderApiKeyConfigured({
        provider,
        cfg: configuredProvider("media-secret", ` ${provider.toUpperCase()} `),
      }),
    ).toBe(true);
  });

  it.each([
    "   ",
    "oauth:media-readiness-provider",
    "custom-local",
    "gcp-vertex-credentials",
    "secretref-managed",
    "GOOGLE_API_KEY",
  ])("does not mistake non-secret marker %j for a usable configured API key", (apiKey) => {
    vi.stubEnv("GOOGLE_API_KEY", "");
    expect(isProviderApiKeyConfigured({ provider, cfg: configuredProvider(apiKey) })).toBe(false);
  });

  it("recognizes allowed env SecretRefs through their configured provider alias", () => {
    vi.stubEnv("MEDIA_READINESS_TEST_KEY", "resolved-media-secret");
    const cfg = configuredProvider({
      source: "env",
      provider: "team-env",
      id: "MEDIA_READINESS_TEST_KEY",
    });
    cfg.secrets = {
      defaults: { env: "team-env" },
      providers: {
        "team-env": { source: "env", allowlist: ["MEDIA_READINESS_TEST_KEY"] },
      },
    };

    expect(isProviderApiKeyConfigured({ provider, cfg })).toBe(true);
  });

  it.each(["file", "exec"] as const)(
    "keeps an unresolved %s SecretRef unavailable until its managed runtime snapshot resolves it",
    (source) => {
      const sourceConfig = configuredProvider({ source, provider: "managed", id: "media-key" });
      expect(isProviderApiKeyConfigured({ provider, cfg: sourceConfig })).toBe(false);

      const runtimeConfig = configuredProvider("resolved-managed-media-secret");
      setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

      expect(isProviderApiKeyConfigured({ provider, cfg: sourceConfig })).toBe(true);
    },
  );

  it("does not advertise missing or provider-disallowed env SecretRefs", () => {
    vi.stubEnv("MEDIA_READINESS_TEST_KEY", "resolved-media-secret");
    const cfg = configuredProvider({
      source: "env",
      provider: "team-env",
      id: "MEDIA_READINESS_TEST_KEY",
    });
    cfg.secrets = {
      providers: { "team-env": { source: "env", allowlist: ["OTHER_MEDIA_KEY"] } },
    };

    expect(isProviderApiKeyConfigured({ provider, cfg })).toBe(false);
    vi.stubEnv("MEDIA_READINESS_TEST_KEY", "");
    cfg.secrets.providers!["team-env"] = { source: "env" };
    expect(isProviderApiKeyConfigured({ provider, cfg })).toBe(false);
  });

  it("preserves existing behavior when callers omit runtime configuration", () => {
    expect(isProviderApiKeyConfigured({ provider })).toBe(false);
  });

  it("applies provider-owned credential acceptance only when explicitly requested", () => {
    const cfg = configuredProvider("blocked-provider-key");

    expect(isProviderApiKeyConfigured({ provider, cfg })).toBe(true);
    expect(
      isProviderApiKeyConfigured({
        provider,
        cfg,
        acceptsApiKey: (apiKey) => !apiKey.startsWith("blocked-"),
      }),
    ).toBe(false);
    expect(
      isProviderApiKeyConfigured({
        provider,
        cfg: configuredProvider("allowed-provider-key"),
        acceptsApiKey: (apiKey) => !apiKey.startsWith("blocked-"),
      }),
    ).toBe(true);
  });

  it.each([
    ["allowed-profile-key", "blocked-environment-key", true],
    ["blocked-profile-key", "allowed-environment-key", false],
  ])(
    "applies credential acceptance to the higher-priority auth profile %s",
    async (profileKey, envKey, expected) => {
      vi.stubEnv("GOOGLE_API_KEY", envKey);
      const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-media-key-policy-"));

      try {
        saveAuthProfileStore(
          {
            version: 1,
            profiles: {
              "google:selected": {
                type: "api_key",
                provider: "google",
                key: profileKey,
              },
            },
          },
          agentDir,
          { filterExternalAuthProfiles: false, syncExternalCli: false },
        );

        expect(
          isProviderApiKeyConfigured({
            provider: "google",
            agentDir,
            profileTypes: ["api_key"],
            acceptsApiKey: (apiKey) => !apiKey.startsWith("blocked-"),
          }),
        ).toBe(expected);
      } finally {
        clearRuntimeAuthProfileStoreSnapshots();
        await fs.rm(agentDir, { force: true, recursive: true });
      }
    },
  );

  it("keeps an explicit config credential above rejected environment credentials", () => {
    vi.stubEnv("GOOGLE_API_KEY", "blocked-environment-key");
    const cfg = configuredProvider("allowed-config-key", "google");
    const google = cfg.models?.providers?.google;
    if (!google) {
      throw new Error("missing configured Google provider");
    }
    google.auth = "api-key";

    expect(
      isProviderApiKeyConfigured({
        provider: "google",
        cfg,
        acceptsApiKey: (apiKey) => !apiKey.startsWith("blocked-"),
      }),
    ).toBe(true);
  });

  it.each([
    ["oauth", ["api_key"], false],
    ["token", ["api_key"], false],
    ["oauth", ["oauth"], true],
    ["token", ["token"], true],
    ["api-key", ["api_key"], true],
  ] as const)(
    "honors configured %s credential mode for allowed profile types %j",
    (auth, profileTypes, expected) => {
      const cfg = configuredProvider("media-api-key");
      const entry = cfg.models?.providers?.[provider];
      if (!entry) {
        throw new Error("missing configured media provider");
      }
      entry.auth = auth;

      expect(isProviderApiKeyConfigured({ provider, cfg, profileTypes })).toBe(expected);
    },
  );

  it("honors hydrated managed-SecretRef credential modes for API-key-only consumers", () => {
    const sourceConfig = configuredProvider({
      source: "file",
      provider: "managed",
      id: "media-key",
    });
    const runtimeConfig = configuredProvider("resolved-managed-media-secret");
    const sourceProvider = sourceConfig.models?.providers?.[provider];
    const runtimeProvider = runtimeConfig.models?.providers?.[provider];
    if (!sourceProvider || !runtimeProvider) {
      throw new Error("missing managed media provider configuration");
    }
    sourceProvider.auth = "oauth";
    runtimeProvider.auth = "oauth";
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

    expect(
      isProviderApiKeyConfigured({ provider, cfg: sourceConfig, profileTypes: ["api_key"] }),
    ).toBe(false);
    expect(
      isProviderApiKeyConfigured({ provider, cfg: sourceConfig, profileTypes: ["oauth"] }),
    ).toBe(true);
  });

  it.each([
    {
      label: "compatible API-key profile",
      credential: { type: "api_key", provider, key: "profile-api-key" },
      profileTypes: ["api_key"],
      expected: true,
    },
    {
      label: "OAuth profile rejected by provider-entry credential policy",
      credential: {
        type: "oauth",
        provider,
        access: "oauth-access",
        refresh: "oauth-refresh",
        expires: Date.now() + 60_000,
      },
      profileTypes: ["api_key"],
      expected: false,
    },
    {
      label: "token profile rejected by an API-key-only consumer",
      credential: { type: "token", provider, token: "profile-token" },
      profileTypes: ["api_key"],
      expected: false,
    },
    {
      label: "token profile accepted by a token consumer",
      credential: { type: "token", provider, token: "profile-token" },
      profileTypes: ["token"],
      expected: true,
    },
    {
      label: "API-key profile owned by a different provider",
      credential: { type: "api_key", provider: "unrelated-provider", key: "wrong-provider-key" },
      profileTypes: ["api_key"],
      expected: false,
    },
    {
      label: "API-key profile with missing credential material",
      credential: { type: "api_key", provider },
      profileTypes: ["api_key"],
      expected: false,
    },
    {
      label: "API-key profile with an unresolved env SecretRef",
      credential: {
        type: "api_key",
        provider,
        keyRef: { source: "env", provider: "default", id: "MEDIA_PROFILE_MISSING_SECRET" },
      },
      profileTypes: ["api_key"],
      expected: false,
    },
  ] satisfies Array<{
    label: string;
    credential: AuthProfileCredential;
    profileTypes: AuthProfileCredential["type"][];
    expected: boolean;
  }>)(
    "classifies configured profile references: $label",
    async ({ credential, expected, profileTypes }) => {
      vi.stubEnv("MEDIA_PROFILE_MISSING_SECRET", "");
      const profileId = `${provider}:selected`;
      const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-media-profile-binding-"));
      try {
        saveAuthProfileStore({ version: 1, profiles: { [profileId]: credential } }, agentDir, {
          filterExternalAuthProfiles: false,
          syncExternalCli: false,
        });

        expect(
          isProviderApiKeyConfigured({
            provider,
            agentDir,
            cfg: configuredProvider(profileId),
            profileTypes,
          }),
        ).toBe(expected);
      } finally {
        clearRuntimeAuthProfileStoreSnapshots();
        await fs.rm(agentDir, { force: true, recursive: true });
      }
    },
  );

  it("preserves API-key-only profile filters while accepting actual config API keys", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-media-auth-readiness-"));
    try {
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            [`${provider}:oauth`]: {
              type: "oauth",
              provider,
              access: "oauth-access",
              refresh: "oauth-refresh",
              expires: Date.now() + 60_000,
            },
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false, syncExternalCli: false },
      );

      expect(isProviderApiKeyConfigured({ provider, agentDir })).toBe(true);
      expect(
        isProviderApiKeyConfigured({
          provider,
          agentDir,
          cfg: configuredProvider(`oauth:${provider}`),
          profileTypes: ["api_key"],
        }),
      ).toBe(false);
      expect(
        isProviderApiKeyConfigured({
          provider,
          agentDir,
          cfg: configuredProvider("media-api-key"),
          profileTypes: ["api_key"],
        }),
      ).toBe(true);
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
      await fs.rm(agentDir, { force: true, recursive: true });
    }
  });
});

describe("provider auth profile helpers", () => {
  let fallbackStoreCase: FallbackStoreCaseResult;

  beforeAll(async () => {
    fallbackStoreCase = await runFallbackStoreCase();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    vi.doUnmock("../agents/agent-scope-config.js");
    vi.doUnmock("../agents/auth-profiles/external-cli-discovery.js");
    vi.doUnmock("../agents/auth-profiles/oauth.js");
    vi.doUnmock("../agents/auth-profiles/order.js");
    vi.doUnmock("../plugins/provider-auth-availability.js");
    vi.resetModules();
  });

  it("resolves API keys from the fallback store that supplied usable profile ids", () => {
    expect(fallbackStoreCase.profileIds).toEqual(["openai:default"]);
    expect(fallbackStoreCase.resolvedKey).toBe("fallback-key");
    expect(fallbackStoreCase.resolveApiKeyCalls).toContainEqual([
      expect.objectContaining({
        agentDir: "/tmp/openclaw-agent",
        profileId: "openai:default",
        store: expect.objectContaining({
          profiles: expect.objectContaining({
            "openai:default": expect.objectContaining({ key: "fallback-key" }),
          }),
        }),
      }),
    ]);
  });

  it("filters auth profile API-key resolution by credential type", async () => {
    vi.resetModules();

    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:oauth": {
          type: "oauth",
          provider: "openai",
          access: "oauth-access",
          refresh: "oauth-refresh",
          expires: Date.now() + 60_000,
        },
        "openai:key": {
          type: "api_key",
          provider: "openai",
          key: "sk-profile",
        },
      },
    };
    const resolveApiKeyForProfile = vi.fn(
      async (params: { store: AuthProfileStore; profileId: string }) => {
        const profile = params.store.profiles[params.profileId];
        if (profile?.type === "oauth") {
          return {
            apiKey: profile.access,
            provider: profile.provider,
            profileId: params.profileId,
            profileType: profile.type,
          };
        }
        if (profile?.type === "api_key" && profile.key) {
          return {
            apiKey: profile.key,
            provider: profile.provider,
            profileId: params.profileId,
            profileType: profile.type,
          };
        }
        return null;
      },
    );

    vi.doMock("../agents/agent-scope-config.js", async () => {
      const { resolveAgentDir } = await vi.importActual<
        typeof import("../agents/agent-scope-config.js")
      >("../agents/agent-scope-config.js");
      return { resolveAgentDir, resolveDefaultAgentDir: () => "/tmp/openclaw-agent" };
    });
    vi.doMock("../agents/auth-profiles/oauth.js", () => ({
      resolveApiKeyForProfile,
    }));
    vi.doMock("../agents/auth-profiles/order.js", () => ({
      resolveAuthProfileOrder: ({
        provider,
        store: profileStore,
      }: {
        provider: string;
        store: AuthProfileStore;
      }) =>
        Object.entries(profileStore.profiles)
          .filter(([, profile]) => profile.provider === provider)
          .map(([profileId]) => profileId),
    }));
    // mock-isolation: Profile-list tests use this synthetic credential snapshot.
    vi.doMock("../plugins/provider-auth-availability.js", async () => {
      const { createProviderAuthAvailability } =
        await import("../plugins/provider-auth-availability-core.js");
      const { findPersistedAuthProfileCredential } =
        await import("../agents/auth-profiles/store.js");
      const { findPersistedAuthProfileCredentialAsync } =
        await import("../agents/auth-profiles/store-runtime.js");
      return createProviderAuthAvailability({
        findPersistedAuthProfileCredential,
        findPersistedAuthProfileCredentialAsync,
        ensureAuthProfileStore: vi.fn(() => store),
        ensureAuthProfileStoreAsync: vi.fn(async () => store),
        loadAuthProfileStoreWithoutExternalProfilesAsync: vi.fn(async () => ({
          version: 1,
          profiles: {},
        })),
        loadAuthProfileStoreForRuntimeAsync: vi.fn(async () => store),
        loadAuthProfileStoreForSecretsRuntime: vi.fn(() => store),
        loadAuthProfileStoreWithoutExternalProfiles: vi.fn(() => ({ version: 1, profiles: {} })),
      });
    });

    const { resolveProviderAuthProfileApiKey } = await import("./provider-auth.js");

    await expect(
      resolveProviderAuthProfileApiKey({
        provider: "openai",
        profileTypes: ["api_key"],
      }),
    ).resolves.toBe("sk-profile");
    expect(resolveApiKeyForProfile).toHaveBeenCalledTimes(1);
    expect(resolveApiKeyForProfile).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "openai:key" }),
    );
  });

  it("only discovers external CLI auth when provider resolution opts in", async () => {
    vi.resetModules();

    const primaryStore: AuthProfileStore = {
      version: 1,
      profiles: {},
    };
    const externalStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:default": {
          type: "oauth",
          provider: "openai",
          access: "oauth-access",
          refresh: "oauth-refresh",
          expires: Date.now() + 60_000,
        },
      },
    };
    const externalCli = { mode: "scoped", providerIds: ["openai"] };
    const loadAuthProfileStoreForSecretsRuntime = vi.fn(
      (_agentDir?: string, options?: { externalCli?: unknown }) =>
        options?.externalCli ? externalStore : primaryStore,
    );

    vi.doMock("../agents/agent-scope-config.js", async () => {
      const { resolveAgentDir } = await vi.importActual<
        typeof import("../agents/agent-scope-config.js")
      >("../agents/agent-scope-config.js");
      return { resolveAgentDir, resolveDefaultAgentDir: () => "/tmp/openclaw-agent" };
    });
    vi.doMock("../agents/auth-profiles/external-cli-discovery.js", () => ({
      externalCliDiscoveryForProviderAuth: vi.fn(() => externalCli),
    }));
    vi.doMock("../agents/auth-profiles/oauth.js", () => ({
      resolveApiKeyForProfile: vi.fn(),
    }));
    vi.doMock("../agents/auth-profiles/order.js", () => ({
      resolveAuthProfileOrder: ({
        provider,
        store,
      }: {
        provider: string;
        store: AuthProfileStore;
      }) =>
        Object.entries(store.profiles)
          .filter(([, profile]) => profile.provider === provider)
          .map(([profileId]) => profileId),
    }));
    // mock-isolation: Availability controls the synthetic external CLI discovery snapshots.
    vi.doMock("../plugins/provider-auth-availability.js", async () => {
      const { createProviderAuthAvailability } =
        await import("../plugins/provider-auth-availability-core.js");
      const { findPersistedAuthProfileCredential } =
        await import("../agents/auth-profiles/store.js");
      const { findPersistedAuthProfileCredentialAsync } =
        await import("../agents/auth-profiles/store-runtime.js");
      return createProviderAuthAvailability({
        findPersistedAuthProfileCredential,
        findPersistedAuthProfileCredentialAsync,
        ensureAuthProfileStore: vi.fn(() => primaryStore),
        ensureAuthProfileStoreAsync: vi.fn(async () => primaryStore),
        loadAuthProfileStoreWithoutExternalProfilesAsync: vi.fn(async () => ({
          version: 1,
          profiles: {},
        })),
        loadAuthProfileStoreForRuntimeAsync: vi.fn(
          async (...args: Parameters<typeof loadAuthProfileStoreForSecretsRuntime>) =>
            loadAuthProfileStoreForSecretsRuntime(...args),
        ),
        loadAuthProfileStoreForSecretsRuntime,
        loadAuthProfileStoreWithoutExternalProfiles: vi.fn(() => ({ version: 1, profiles: {} })),
      });
    });

    const { isProviderAuthProfileConfigured } = await import("./provider-auth.js");

    expect(isProviderAuthProfileConfigured({ provider: "openai" })).toBe(false);
    expect(
      isProviderAuthProfileConfigured({
        provider: "openai",
        includeExternalCliAuth: true,
      }),
    ).toBe(true);
    expect(loadAuthProfileStoreForSecretsRuntime).toHaveBeenNthCalledWith(1, "/tmp/openclaw-agent");
    expect(loadAuthProfileStoreForSecretsRuntime).toHaveBeenNthCalledWith(
      2,
      "/tmp/openclaw-agent",
      { externalCli },
    );
  });
});

describe("Copilot domain normalization", () => {
  it("rejects unsafe hostnames and falls back to github.com", () => {
    expect(normalizeGithubCopilotDomain("https://evil.com/login")).toBe("github.com");
    expect(normalizeGithubCopilotDomain("user@host")).toBe("github.com");
    expect(normalizeGithubCopilotDomain("acme.ghe.com")).toBe("acme.ghe.com");
    expect(normalizeGithubCopilotDomain("  ACME.GHE.COM  ")).toBe("acme.ghe.com");
  });

  it("locks the host allowlist to github.com and single-label *.ghe.com tenant roots", () => {
    // Allowed: public host and single-label data-residency tenant roots.
    expect(normalizeGithubCopilotDomain("github.com")).toBe("github.com");
    expect(normalizeGithubCopilotDomain("acme.ghe.com")).toBe("acme.ghe.com");

    // Rejected: derived service hosts under a tenant. GitHub documents these as
    // `*.SUBDOMAIN.ghe.com` endpoints; storing one would template broken hosts
    // like `api.api.acme.ghe.com` for the token exchange.
    expect(normalizeGithubCopilotDomain("api.acme.ghe.com")).toBe("github.com");
    expect(normalizeGithubCopilotDomain("copilot-api.acme.ghe.com")).toBe("github.com");
    expect(normalizeGithubCopilotDomain("a.b.ghe.com")).toBe("github.com");

    // Rejected: arbitrary hosts, look-alikes, and the bare non-tenant apex.
    expect(normalizeGithubCopilotDomain("evil.com")).toBe("github.com");
    expect(normalizeGithubCopilotDomain("ghe.com")).toBe("github.com");
    expect(normalizeGithubCopilotDomain("github.com.evil.com")).toBe("github.com");
    expect(normalizeGithubCopilotDomain("evilghe.com")).toBe("github.com");
    expect(normalizeGithubCopilotDomain("acme.ghe.com.evil.com")).toBe("github.com");
  });
});
