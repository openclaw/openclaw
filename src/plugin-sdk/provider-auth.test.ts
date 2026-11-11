import type { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  readClaudeCliCredentialsCached as readClaude,
} from "./provider-auth.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function writeJson(file: string, value: unknown) {
  await fs.writeFile(file, JSON.stringify(value));
}

async function writeCredentials(dir: string, prefix: string, subscription?: string) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, ".credentials.json"),
    claudeCredentialJson(`${prefix}-access`, `${prefix}-refresh`, subscription),
  );
}

function readKeychain(
  execute: typeof execSync,
  overrides: Omit<NonNullable<Parameters<typeof readClaude>[0]>, "execSync" | "platform">,
) {
  return readClaude({
    execSync: execute,
    platform: "darwin",
    ...overrides,
  });
}

function oauthProfile(): AuthProfileCredential {
  return {
    type: "oauth",
    provider: "openai",
    access: "oauth-access",
    refresh: "oauth-refresh",
    expires: Date.now() + 60_000,
  };
}

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
  afterEach(() => vi.unstubAllEnvs());
  it("keeps the shipped Claude credential reader functional during its deprecation window", async () => {
    const homeDir = tempDirs.make("openclaw-sdk-claude-auth-");
    const credentialsDir = path.join(homeDir, ".claude");
    await writeCredentials(credentialsDir, "legacy", "max");

    expect(readClaude({ homeDir, platform: "linux", ttlMs: 0 })).toEqual({
      type: "oauth",
      provider: "anthropic",
      access: "legacy-access",
      refresh: "legacy-refresh",
      expires: 1_800_000_000_000,
      subscriptionType: "max",
    });
  });

  it.each([false, true])(
    "keeps config identity scoped to its credential store (split=%s)",
    async (split) => {
      const configDir = tempDirs.make("openclaw-sdk-claude-config-");
      const storageDir = split ? tempDirs.make("openclaw-sdk-claude-storage-") : configDir;
      await writeCredentials(storageDir, "configured");
      await writeJson(path.join(configDir, ".claude.json"), {
        oauthAccount: { emailAddress: "configured@example.com" },
      });
      vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
      if (split) {
        vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", storageDir);
      }
      const credential = readClaude({ platform: "linux", ttlMs: 0 });
      expect(credential).toMatchObject({
        type: "oauth",
        access: "configured-access",
        refresh: "configured-refresh",
      });
      if (split) {
        expect(credential).not.toHaveProperty("email");
      } else {
        expect(credential).toMatchObject({ email: "configured@example.com" });
      }
    },
  );

  it("isolates cached config metadata when profiles share secure storage", async () => {
    const profiles = ["first", "second"].map((name) => ({
      configDir: tempDirs.make(`openclaw-sdk-claude-${name}-`),
      helper: `${name}-profile-helper`,
    }));
    const sharedMtime = new Date(1_800_000_000_000);
    for (const { configDir, helper } of profiles) {
      const settingsPath = path.join(configDir, "settings.json");
      await writeJson(settingsPath, { apiKeyHelper: helper });
      await fs.utimes(settingsPath, sharedMtime, sharedMtime);
    }
    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", tempDirs.make("openclaw-sdk-shared-storage-"));
    for (const { configDir, helper } of profiles) {
      vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
      expect(readClaude({ platform: "linux", ttlMs: 60_000 })).toEqual({
        type: "api_key_helper",
        provider: "anthropic",
        helperHash: createHash("sha256").update(helper).digest("hex"),
      });
    }
  });

  it("pins an empty secure-storage override to the default credential store", async () => {
    const osHome = tempDirs.make("openclaw-sdk-claude-default-home-");
    const defaultCredentialsDir = path.join(osHome, ".claude");
    const configDir = tempDirs.make("openclaw-sdk-claude-other-config-");
    await writeCredentials(defaultCredentialsDir, "default-store");
    vi.stubEnv("HOME", osHome);
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", "");

    expect(readClaude({ platform: "linux", ttlMs: 0 })).toMatchObject({
      access: "default-store-access",
      refresh: "default-store-refresh",
    });
  });

  it("selects and caches the macOS Keychain service by secure-storage config", () => {
    const firstDir = "/tmp/claude-secure-one";
    const secondDir = "/tmp/claude-secure-two";
    const serviceFor = (configDir: string) =>
      `Claude Code-credentials-${createHash("sha256").update(configDir).digest("hex").slice(0, 8)}`;
    const execute = vi.fn((command: string, options: { timeout?: number }) => {
      expect(command).toMatch(/^\/usr\/bin\/security find-generic-password /u);
      expect(options).not.toHaveProperty("timeout");
      return claudeCredentialJson(
        command.includes(serviceFor(firstDir)) ? "first-access" : "second-access",
        "keychain-refresh",
      );
    }) as unknown as typeof execSync;

    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", firstDir);
    expect(readKeychain(execute, { ttlMs: 60_000 })).toMatchObject({ access: "first-access" });

    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", secondDir);
    expect(readKeychain(execute, { ttlMs: 60_000 })).toMatchObject({ access: "second-access" });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenLastCalledWith(
      expect.stringContaining(serviceFor(secondDir)),
      expect.any(Object),
    );
  });

  it("keeps explicit no-prompt macOS Keychain reads presence-only", () => {
    const execute = vi.fn((command: string) => {
      expect(command).toMatch(/^\/usr\/bin\/security find-generic-password /u);
      expect(command).not.toContain(" -w");
      return "keychain metadata";
    }) as unknown as typeof execSync;
    const onStoredCredentialUnreadable = vi.fn();

    expect(
      readKeychain(execute, {
        allowKeychainPrompt: false,
        tryKeychainWithoutPrompt: true,
        onStoredCredentialUnreadable,
        ttlMs: 0,
      }),
    ).toBeNull();
    expect(execute).toHaveBeenCalledOnce();
    expect(onStoredCredentialUnreadable).toHaveBeenCalledOnce();
  });

  it("does not reuse a no-prompt Keychain miss for a prompt-enabled read", () => {
    const homeDir = tempDirs.make("openclaw-sdk-claude-keychain-cache-");
    const execute = vi.fn((command: string) =>
      command.includes(" -w")
        ? claudeCredentialJson("prompted-access", "prompted-refresh")
        : "keychain metadata",
    ) as unknown as typeof execSync;

    expect(
      readKeychain(execute, {
        allowKeychainPrompt: false,
        homeDir,
        tryKeychainWithoutPrompt: true,
        ttlMs: 60_000,
      }),
    ).toBeNull();
    expect(
      readKeychain(execute, {
        allowKeychainPrompt: true,
        homeDir,
        tryKeychainWithoutPrompt: true,
        ttlMs: 60_000,
      }),
    ).toMatchObject({ type: "oauth", access: "prompted-access" });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(expect.stringContaining(" -w"), expect.any(Object));
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
          [providerId]: { apiKey, baseUrl: "https://media.example.test/v1", models: [] },
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
    },
    {
      label: "API-key profile with an unresolved env SecretRef",
      credential: {
        type: "api_key",
        provider,
        keyRef: { source: "env", provider: "default", id: "MEDIA_PROFILE_MISSING_SECRET" },
      },
    },
  ] satisfies Array<{
    label: string;
    credential: AuthProfileCredential;
  }>)("classifies configured profile references: $label", async ({ credential }) => {
    vi.stubEnv("MEDIA_PROFILE_MISSING_SECRET", "");
    const profileId = `${provider}:selected`;
    const agentDir = tempDirs.make("openclaw-media-profile-binding-");
    saveAuthProfileStore({ version: 1, profiles: { [profileId]: credential } }, agentDir, {
      filterExternalAuthProfiles: false,
      syncExternalCli: false,
    });

    expect(
      isProviderApiKeyConfigured({
        provider,
        agentDir,
        cfg: configuredProvider(profileId),
        profileTypes: ["api_key"],
      }),
    ).toBe(false);
  });
});

describe("provider auth profile helpers", () => {
  const emptyStore = (): AuthProfileStore => ({ version: 1, profiles: {} });
  async function mockProfileAvailability(
    store: AuthProfileStore,
    loadStore = vi.fn((_agentDir?: string, _options?: { externalCli?: unknown }) => store),
  ) {
    // mock-isolation: Use synthetic profiles while retaining real availability decisions.
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
        loadAuthProfileStoreWithoutExternalProfilesAsync: vi.fn(async () => emptyStore()),
        loadAuthProfileStoreForRuntimeAsync: vi.fn(async (...args: Parameters<typeof loadStore>) =>
          loadStore(...args),
        ),
        loadAuthProfileStoreForSecretsRuntime: loadStore,
        loadAuthProfileStoreWithoutExternalProfiles: vi.fn(emptyStore),
      });
    });
  }

  beforeEach(() => {
    vi.resetModules();
    vi.doMock("../agents/agent-scope-config.js", async () => {
      const { resolveAgentDir } = await vi.importActual<
        typeof import("../agents/agent-scope-config.js")
      >("../agents/agent-scope-config.js");
      return { resolveAgentDir, resolveDefaultAgentDir: () => "/tmp/openclaw-agent" };
    });
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
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(() => {
    vi.doUnmock("../agents/agent-scope-config.js");
    vi.doUnmock("../agents/auth-profiles/external-cli-discovery.js");
    vi.doUnmock("../agents/auth-profiles/oauth.js");
    vi.doUnmock("../agents/auth-profiles/order.js");
    vi.doUnmock("../plugins/provider-auth-availability.js");
    vi.resetModules();
  });

  it("filters auth profile API-key resolution by credential type", async () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:oauth": oauthProfile(),
        "openai:key": { type: "api_key", provider: "openai", key: "sk-profile" },
      },
    };
    const resolveApiKeyForProfile = vi.fn(
      async (params: { store: AuthProfileStore; profileId: string }) => {
        const profile = params.store.profiles[params.profileId];
        if (!profile) {
          return null;
        }
        const apiKey =
          profile.type === "oauth"
            ? profile.access
            : profile.type === "api_key"
              ? profile.key
              : undefined;
        return apiKey
          ? {
              apiKey,
              provider: profile.provider,
              profileId: params.profileId,
              profileType: profile.type,
            }
          : null;
      },
    );

    // mock-isolation: fixture profiles must not refresh real OAuth credentials.
    vi.doMock("../agents/auth-profiles/oauth.js", () => ({ resolveApiKeyForProfile }));
    await mockProfileAvailability(store);

    const { resolveProviderAuthProfileApiKey } = await import("./provider-auth.js");

    await expect(
      resolveProviderAuthProfileApiKey({ provider: "openai", profileTypes: ["api_key"] }),
    ).resolves.toBe("sk-profile");
    expect(resolveApiKeyForProfile).toHaveBeenCalledTimes(1);
    expect(resolveApiKeyForProfile).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "openai:key" }),
    );
  });

  it("only discovers external CLI auth when provider resolution opts in", async () => {
    const primaryStore: AuthProfileStore = {
      version: 1,
      profiles: {},
    };
    const externalStore: AuthProfileStore = {
      version: 1,
      profiles: { "openai:default": oauthProfile() },
    };
    const externalCli = { mode: "scoped", providerIds: ["openai"] };
    const loadAuthProfileStoreForSecretsRuntime = vi.fn(
      (_agentDir?: string, options?: { externalCli?: unknown }) =>
        options?.externalCli ? externalStore : primaryStore,
    );

    vi.doMock("../agents/auth-profiles/external-cli-discovery.js", () => ({
      externalCliDiscoveryForProviderAuth: vi.fn(() => externalCli),
    }));
    // mock-isolation: availability discovery must not refresh real OAuth credentials.
    vi.doMock("../agents/auth-profiles/oauth.js", () => ({ resolveApiKeyForProfile: vi.fn() }));
    await mockProfileAvailability(primaryStore, loadAuthProfileStoreForSecretsRuntime);

    const { isProviderAuthProfileConfigured } = await import("./provider-auth.js");

    expect(isProviderAuthProfileConfigured({ provider: "openai" })).toBe(false);
    expect(
      isProviderAuthProfileConfigured({ provider: "openai", includeExternalCliAuth: true }),
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
    expect(["github.com", "acme.ghe.com"].map(normalizeGithubCopilotDomain)).toEqual([
      "github.com",
      "acme.ghe.com",
    ]);
    // Service subdomains would produce broken token-exchange hosts such as api.api.acme.ghe.com.
    const rejected = [
      "api.acme.ghe.com",
      "copilot-api.acme.ghe.com",
      "a.b.ghe.com",
      "evil.com",
      "ghe.com",
      "github.com.evil.com",
      "evilghe.com",
      "acme.ghe.com.evil.com",
    ];
    expect(rejected.map(normalizeGithubCopilotDomain)).toEqual(rejected.map(() => "github.com"));
  });
});
