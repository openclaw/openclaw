import type { execSync } from "node:child_process";
// Provider auth tests cover credential resolution, setup state, and auth method contracts.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
} from "../agents/auth-profiles.js";
import type { AuthProfileCredential, AuthProfileStore } from "../agents/auth-profiles/types.js";
import { clearRuntimeConfigSnapshot } from "../config/config.js";
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

  it("selects and caches the macOS Keychain service by secure-storage config", () => {
    const firstDir = "/tmp/claude-secure-one";
    const secondDir = "/tmp/claude-secure-two";
    const serviceFor = (configDir: string) =>
      `Claude Code-credentials-${createHash("sha256").update(configDir).digest("hex").slice(0, 8)}`;
    const execSyncImpl = vi.fn((command: string, options: { timeout?: number }) => {
      expect(command).toMatch(/^\/usr\/bin\/security find-generic-password /u);
      expect(options).not.toHaveProperty("timeout");
      return JSON.stringify({
        claudeAiOauth: {
          accessToken: command.includes(serviceFor(firstDir)) ? "first-access" : "second-access",
          refreshToken: "keychain-refresh",
          expiresAt: 1_800_000_000_000,
        },
      });
    }) as unknown as typeof execSync;

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
});

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

  it.each([
    {
      label: "API-key profile owned by a different provider",
      credential: { type: "api_key", provider: "unrelated-provider", key: "wrong-provider-key" },
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
});

describe("provider auth profile helpers", () => {
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
