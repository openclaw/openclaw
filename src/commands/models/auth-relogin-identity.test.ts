// Model auth tests cover provider auth status, expiry, and display helpers.

import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSharedMainAuthAgentDir } from "../../agents/auth-profiles/shared-main-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { ConfigWriteOptions } from "../../config/io.js";
import type { ProviderPlugin } from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";

type PersistProviderAuthCall = {
  agentDir?: string;
  validateCurrentCredential?: (profileId: string, credential: unknown) => void;
  profiles?: Array<{
    profileId?: string;
    credential?: {
      provider?: string;
      token?: string;
      tokenRef?: unknown;
      type?: string;
    };
  }>;
};

function readMockCallArg(mock: { mock: { calls: unknown[][] } }, index = 0): unknown {
  const value = mock.mock.calls[index]?.[0];
  if (!value) {
    throw new Error("Expected mock call argument");
  }
  return value;
}

const mocks = vi.hoisted(() => ({
  clackCancel: vi.fn(),
  clackConfirm: vi.fn(),
  clackIsCancel: vi.fn((value: unknown) => value === Symbol.for("clack:cancel")),
  clackPassword: vi.fn(),
  clackSelect: vi.fn(),
  clackText: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
  resolveAgentDir: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveDefaultAgentWorkspaceDir: vi.fn(),
  isCliProvider: vi.fn(),
  upsertAuthProfile: vi.fn(),
  upsertAuthProfileWithLock: vi.fn(),
  persistProviderAuthProfilesAfterLogin: vi.fn(),
  removeProviderAuthProfilesWithLock: vi.fn(),
  authProfileStore: { version: 1, profiles: {} } as {
    version: number;
    profiles: Record<string, unknown>;
  },
  loadAuthProfileStoreWithoutExternalProfiles: vi.fn(),
  resolvePluginProvidersCore: vi.fn(),
  createClackPrompter: vi.fn(),
  loadValidConfigSnapshotOrThrow: vi.fn(),
  updateConfig: vi.fn(),
  logConfigUpdated: vi.fn(),
  openUrl: vi.fn(),
  isRemoteEnvironment: vi.fn(() => false),
  validateAnthropicSetupToken: vi.fn<() => string | undefined>(() => undefined),
  promoteAuthProfileInOrder: vi.fn(),
  tryImportProviderCredential: vi.fn(),
  callGateway: vi.fn(),
  isImplicitLocalGatewayTarget: vi.fn(() => Promise.resolve(true)),
  resolvePluginSetupProviderCore: vi.fn(),
  resolvePluginSetupRegistry: vi.fn(),
  readSecretStoreValue: vi.fn(() => ({
    ok: false as const,
    error: { code: "SECRET_STORE_NOT_FOUND", message: "missing" },
  })),
  writeSecretStoreEntry: vi.fn(),
  deleteSecretStoreEntry: vi.fn(),
}));

vi.mock("../../secrets/store/secret-store.js", () => ({
  readSecretStoreValue: mocks.readSecretStoreValue,
  writeSecretStoreEntry: mocks.writeSecretStoreEntry,
  deleteSecretStoreEntry: mocks.deleteSecretStoreEntry,
}));

vi.mock("../../agents/auth-profiles/profiles.js", () => ({
  promoteAuthProfileInOrder: mocks.promoteAuthProfileInOrder,
  removeProviderAuthProfilesWithLock: mocks.removeProviderAuthProfilesWithLock,
  upsertAuthProfile: mocks.upsertAuthProfile,
  upsertAuthProfileWithLock: mocks.upsertAuthProfileWithLock,
  upsertAuthProfileWithLockOrThrow: mocks.upsertAuthProfileWithLock,
}));

vi.mock("../../agents/auth-profiles/store-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/auth-profiles/store-runtime.js")>()),
  loadAuthProfileStoreWithoutExternalProfiles: mocks.loadAuthProfileStoreWithoutExternalProfiles,
}));

vi.mock("../../plugins/provider-auth-persistence.js", () => ({
  persistProviderAuthProfilesAfterLogin: mocks.persistProviderAuthProfilesAfterLogin,
}));

vi.mock("./auth-credential-import.js", () => ({
  tryImportProviderCredential: mocks.tryImportProviderCredential,
}));

vi.mock("../../plugins/provider-auth-helpers.js", () => ({
  applyAuthProfileConfig: (
    cfg: OpenClawConfig,
    params: {
      profileId: string;
      provider: string;
      mode: "api_key" | "aws-sdk" | "oauth" | "token";
      email?: string;
      displayName?: string;
    },
  ): OpenClawConfig => ({
    ...cfg,
    auth: {
      ...cfg.auth,
      profiles: {
        ...cfg.auth?.profiles,
        [params.profileId]: {
          provider: params.provider,
          mode: params.mode,
          ...(params.email ? { email: params.email } : {}),
          ...(params.displayName ? { displayName: params.displayName } : {}),
        },
      },
    },
  }),
}));

vi.mock("@clack/prompts", () => ({
  cancel: mocks.clackCancel,
  confirm: mocks.clackConfirm,
  isCancel: mocks.clackIsCancel,
  password: mocks.clackPassword,
  select: mocks.clackSelect,
  text: mocks.clackText,
}));

vi.mock("../../agents/agent-scope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/agent-scope.js")>();
  return {
    ...actual,
    resolveDefaultAgentId: mocks.resolveDefaultAgentId,
    resolveAgentDir: mocks.resolveAgentDir,
    resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  };
});

vi.mock("../../agents/workspace.js", () => ({
  resolveDefaultAgentWorkspaceDir: mocks.resolveDefaultAgentWorkspaceDir,
}));

vi.mock("../../agents/model-selection-cli.js", () => ({
  isCliProvider: mocks.isCliProvider,
}));

vi.mock("../../plugins/providers.runtime.js", () => ({
  resolvePluginProvidersCore: mocks.resolvePluginProvidersCore,
}));

vi.mock("../../plugins/setup-registry.js", () => ({
  resolvePluginSetupProviderCore: mocks.resolvePluginSetupProviderCore,
  resolvePluginSetupRegistry: mocks.resolvePluginSetupRegistry,
}));

vi.mock("../../wizard/clack-prompter.js", () => ({
  createClackPrompter: mocks.createClackPrompter,
}));

vi.mock("./shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared.js")>();
  return {
    ...actual,
    loadValidConfigSnapshotOrThrow: mocks.loadValidConfigSnapshotOrThrow,
    updateConfig: mocks.updateConfig,
  };
});

vi.mock("../../plugins/install-record-commit.js", () => ({
  transformConfigWithPendingPluginInstalls: async (params: {
    transform: (
      current: OpenClawConfig,
      context: { snapshot: { valid: boolean } },
    ) => { nextConfig: OpenClawConfig };
    writeOptions?: ConfigWriteOptions;
  }) => {
    const next = await mocks.updateConfig(
      (current: OpenClawConfig) =>
        params.transform(current, { snapshot: { valid: true } }).nextConfig,
      undefined,
      params.writeOptions?.beforeCommit,
      params.writeOptions,
    );
    return { nextConfig: next, result: next };
  },
}));

vi.mock("../../config/logging.js", () => ({
  logConfigUpdated: mocks.logConfigUpdated,
}));

vi.mock("../../infra/browser-open.js", () => ({
  openUrl: mocks.openUrl,
}));

vi.mock("../../infra/remote-env.js", () => ({
  isRemoteEnvironment: mocks.isRemoteEnvironment,
}));

vi.mock("../../gateway/call.js", async () => {
  const requestErrors = await import("../../../packages/gateway-client/src/request-error.js");
  return {
    callGateway: mocks.callGateway,
    GatewayLocalBackendSharedAuthUnavailableError: class extends Error {},
    isGatewayClientRequestError: (error: unknown) =>
      error instanceof requestErrors.GatewayClientRequestError,
    isImplicitLocalGatewayTarget: mocks.isImplicitLocalGatewayTarget,
  };
});

vi.mock("../../plugins/provider-oauth-flow.js", () => ({
  createVpsAwareOAuthHandlers: vi.fn(() => ({
    onAuth: vi.fn(),
    onPrompt: vi.fn(),
  })),
}));

vi.mock("../auth-token.js", () => ({
  validateAnthropicSetupToken: mocks.validateAnthropicSetupToken,
}));

vi.mock("../../plugins/provider-auth-choice-helpers.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../plugins/provider-auth-choice-helpers.js")>();
  const normalize = (value: string | undefined) => value?.trim().toLowerCase() ?? "";
  const mergePatch = <T>(base: T, patch: unknown): T => {
    if (!isRecord(base) || !isRecord(patch)) {
      return patch as T;
    }
    const next: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      next[key] = mergePatch(next[key], value);
    }
    return next as T;
  };

  return {
    ...actual,
    resolveProviderMatch: vi.fn((providers: ProviderPlugin[], rawProvider?: string) => {
      const requested = normalize(rawProvider);
      return (
        providers.find((provider) => normalize(provider.id) === requested) ??
        providers.find((provider) =>
          provider.aliases?.some((alias) => normalize(alias) === requested),
        ) ??
        null
      );
    }),
    pickAuthMethod: vi.fn((provider: ProviderPlugin, rawMethod?: string) => {
      const requested = normalize(rawMethod);
      return (
        provider.auth.find((method) => normalize(method.id) === requested) ??
        provider.auth.find((method) => normalize(method.label) === requested) ??
        null
      );
    }),
    applyProviderAuthConfigPatch: vi.fn(
      (cfg: OpenClawConfig, patch: unknown, options?: { replaceDefaultModels?: boolean }) => {
        const merged = mergePatch(cfg, patch);
        if (!options?.replaceDefaultModels) {
          return merged;
        }
        const patchModels = (patch as { agents?: { defaults?: { models?: unknown } } })?.agents
          ?.defaults?.models;
        return isRecord(patchModels)
          ? {
              ...merged,
              agents: {
                ...merged.agents,
                defaults: {
                  ...merged.agents?.defaults,
                  models: patchModels,
                },
              },
            }
          : merged;
      },
    ),
    applyDefaultModel: vi.fn((cfg: OpenClawConfig, model: string) => ({
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          models: {
            ...cfg.agents?.defaults?.models,
            [model]: cfg.agents?.defaults?.models?.[model] ?? {},
          },
          model: {
            ...(typeof cfg.agents?.defaults?.model === "object" &&
            "fallbacks" in cfg.agents.defaults.model
              ? { fallbacks: cfg.agents.defaults.model.fallbacks }
              : undefined),
            primary: model,
          },
        },
      },
    })),
  };
});

const { snapshotReloginAuthProfiles } = await import("./auth-relogin-identity.js");
const { runModelsAuthLoginFlowCore } = await import("./auth.js");

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function withInteractiveStdin() {
  const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
  const hadOwnIsTTY = Object.hasOwn(stdin, "isTTY");
  const previousIsTTYDescriptor = Object.getOwnPropertyDescriptor(stdin, "isTTY");
  Object.defineProperty(stdin, "isTTY", {
    configurable: true,
    enumerable: true,
    get: () => true,
  });
  return () => {
    if (previousIsTTYDescriptor) {
      Object.defineProperty(stdin, "isTTY", previousIsTTYDescriptor);
    } else if (!hadOwnIsTTY) {
      delete (stdin as { isTTY?: boolean }).isTTY;
    }
  };
}

function createProvider(params: {
  id: string;
  label?: string;
  auth?: ProviderPlugin["auth"];
  run: NonNullable<ProviderPlugin["auth"]>[number]["run"];
}): ProviderPlugin {
  return {
    id: params.id,
    label: params.label ?? params.id,
    auth: params.auth ?? [
      {
        id: "oauth",
        label: "OAuth",
        kind: "oauth",
        run: params.run,
      },
    ],
  };
}

describe("modelsAuthLoginCommand", () => {
  let restoreStdin: (() => void) | null = null;
  let currentConfig: OpenClawConfig;
  let lastUpdatedConfig: OpenClawConfig | null;
  let runProviderAuth: ReturnType<typeof vi.fn<NonNullable<ProviderPlugin["auth"]>[number]["run"]>>;

  beforeEach(() => {
    vi.clearAllMocks();
    restoreStdin = withInteractiveStdin();
    currentConfig = {};
    lastUpdatedConfig = null;
    mocks.clackCancel.mockReset();
    mocks.clackConfirm.mockReset();
    mocks.clackIsCancel.mockImplementation(
      (value: unknown) => value === Symbol.for("clack:cancel"),
    );
    mocks.clackPassword.mockReset();
    mocks.clackSelect.mockReset();
    mocks.clackText.mockReset();
    mocks.validateAnthropicSetupToken.mockReset();
    mocks.validateAnthropicSetupToken.mockReturnValue(undefined);
    mocks.upsertAuthProfileWithLock.mockReset();
    mocks.upsertAuthProfileWithLock.mockResolvedValue({ version: 1, profiles: {} });
    mocks.persistProviderAuthProfilesAfterLogin.mockReset();
    mocks.persistProviderAuthProfilesAfterLogin.mockImplementation(
      async (params: PersistProviderAuthCall) => {
        for (const profile of params.profiles ?? []) {
          if (profile.profileId) {
            params.validateCurrentCredential?.(
              profile.profileId,
              mocks.authProfileStore.profiles[profile.profileId],
            );
          }
        }
        return params.profiles ?? [];
      },
    );
    mocks.promoteAuthProfileInOrder.mockReset();
    mocks.promoteAuthProfileInOrder.mockResolvedValue({
      ok: true,
      value: { version: 1, profiles: {} },
    });
    mocks.tryImportProviderCredential.mockReset();
    mocks.tryImportProviderCredential.mockResolvedValue(undefined);
    mocks.removeProviderAuthProfilesWithLock.mockReset();
    mocks.removeProviderAuthProfilesWithLock.mockResolvedValue({ version: 1, profiles: {} });
    mocks.authProfileStore = { version: 1, profiles: {} };
    mocks.loadAuthProfileStoreWithoutExternalProfiles.mockReset();
    mocks.loadAuthProfileStoreWithoutExternalProfiles.mockImplementation(
      () => mocks.authProfileStore,
    );

    mocks.resolveDefaultAgentId.mockReturnValue("main");
    mocks.resolveAgentDir.mockReturnValue("/tmp/openclaw/agents/main");
    mocks.resolveAgentWorkspaceDir.mockReturnValue("/tmp/openclaw/workspace");
    mocks.resolveDefaultAgentWorkspaceDir.mockReturnValue("/tmp/openclaw/workspace");
    mocks.isRemoteEnvironment.mockReturnValue(false);
    mocks.isCliProvider.mockReturnValue(false);
    mocks.resolvePluginSetupProviderCore.mockReturnValue(undefined);
    mocks.resolvePluginSetupRegistry.mockReturnValue({
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    });
    mocks.loadValidConfigSnapshotOrThrow.mockImplementation(async () => ({
      sourceConfig: structuredClone(currentConfig),
      runtimeConfig: structuredClone(currentConfig),
    }));
    mocks.updateConfig.mockImplementation(
      async (
        mutator: (cfg: OpenClawConfig) => OpenClawConfig,
        _selectModelRefs: unknown,
        beforeCommit?: ConfigWriteOptions["beforeCommit"],
        writeOptions?: ConfigWriteOptions,
      ) => {
        const nextConfig = mutator(currentConfig);
        await beforeCommit?.();
        writeOptions?.assertCurrent?.();
        lastUpdatedConfig = nextConfig;
        currentConfig = lastUpdatedConfig;
        return lastUpdatedConfig;
      },
    );
    mocks.createClackPrompter.mockReturnValue({
      note: vi.fn(async () => {}),
      select: vi.fn().mockResolvedValue("keep"),
    });
    runProviderAuth = vi
      .fn<NonNullable<ProviderPlugin["auth"]>[number]["run"]>()
      .mockResolvedValue({
        profiles: [
          {
            profileId: "openai:user@example.com",
            credential: {
              type: "oauth",
              provider: "openai",
              access: "access-token",
              refresh: "refresh-token",
              expires: Date.now() + 60_000,
              email: "user@example.com",
            },
          },
        ],
        defaultModel: "openai/gpt-5.5",
      });
    mocks.resolvePluginProvidersCore.mockReturnValue([
      createProvider({
        id: "openai",
        label: "OpenAI Codex",
        run: runProviderAuth as ProviderPlugin["auth"][number]["run"],
      }),
    ]);
    mocks.callGateway.mockReset();
    mocks.callGateway.mockResolvedValue({ refreshed: true });
  });

  afterEach(() => {
    restoreStdin?.();
    restoreStdin = null;
  });

  it("snapshots shared-owner profiles for explicit main-agent relogin", () => {
    mocks.authProfileStore = {
      version: 1,
      profiles: {
        "openai:shared": {
          type: "oauth",
          provider: "openai",
          access: "shared-access",
          refresh: "shared-refresh",
          expires: Date.now() + 60_000,
        },
      },
    };

    expect(
      snapshotReloginAuthProfiles({
        agentDir: resolveSharedMainAuthAgentDir(),
        matchesPersonalAccount: () => true,
      }),
    ).toEqual(mocks.authProfileStore.profiles);
    expect(mocks.loadAuthProfileStoreWithoutExternalProfiles).toHaveBeenCalledWith(undefined);
  });

  it.each([
    {
      name: "same account",
      incomingAccountId: "acct-old",
      expectedProfileId: "openai:setup-old",
    },
    {
      name: "different account",
      incomingAccountId: "acct-new",
      expectedProfileId: "openai:setup-new",
    },
  ])(
    "keeps provider-owned profile identity boundaries for a $name re-login",
    async ({ incomingAccountId, expectedProfileId }) => {
      mocks.authProfileStore = {
        version: 1,
        profiles: {
          "openai:setup-old": {
            type: "oauth",
            provider: "openai",
            access: "old-access",
            refresh: "old-refresh",
            expires: Date.now() - 60_000,
            accountId: "acct-old",
          },
        },
      };
      mocks.removeProviderAuthProfilesWithLock.mockImplementationOnce(async () => {
        Reflect.deleteProperty(mocks.authProfileStore.profiles, "openai:setup-old");
        return mocks.authProfileStore;
      });
      runProviderAuth.mockResolvedValueOnce({
        profiles: [
          {
            profileId: "openai:setup-new",
            credential: {
              type: "oauth",
              provider: "openai",
              access: "new-access",
              refresh: "new-refresh",
              expires: Date.now() + 60_000,
              accountId: incomingAccountId,
            },
          },
        ],
      });
      const matchesPersonalAccount: NonNullable<
        ProviderPlugin["auth"][number]["matchesPersonalAccount"]
      > = (credential, existing) =>
        credential.type === "oauth" &&
        existing.type === "oauth" &&
        credential.provider === existing.provider &&
        credential.accountId === existing.accountId;
      mocks.resolvePluginProvidersCore.mockReturnValue([
        createProvider({
          id: "openai",
          label: "OpenAI Codex",
          run: runProviderAuth as ProviderPlugin["auth"][number]["run"],
          auth: [
            {
              id: "oauth",
              label: "OAuth",
              kind: "oauth",
              run: runProviderAuth as ProviderPlugin["auth"][number]["run"],
              matchesPersonalAccount,
            },
          ],
        }),
      ]);

      await runModelsAuthLoginFlowCore({
        provider: "openai",
        force: true,
        runtime: createRuntime(),
        prompter: mocks.createClackPrompter(),
      });

      const persistCall = readMockCallArg(
        mocks.persistProviderAuthProfilesAfterLogin,
      ) as PersistProviderAuthCall;
      expect(persistCall.profiles?.[0]?.profileId).toBe(expectedProfileId);
      expect(mocks.removeProviderAuthProfilesWithLock).toHaveBeenCalledOnce();
      expect(
        mocks.loadAuthProfileStoreWithoutExternalProfiles.mock.invocationCallOrder[0],
      ).toBeLessThan(mocks.removeProviderAuthProfilesWithLock.mock.invocationCallOrder[0]!);
    },
  );

  it("rejects forced profile reuse when another account reclaims the purged id", async () => {
    mocks.authProfileStore = {
      version: 1,
      profiles: {
        "openai:setup-old": {
          type: "oauth",
          provider: "openai",
          access: "old-access",
          refresh: "old-refresh",
          expires: Date.now() - 60_000,
          accountId: "acct-old",
        },
      },
    };
    mocks.removeProviderAuthProfilesWithLock.mockImplementationOnce(async () => {
      Reflect.deleteProperty(mocks.authProfileStore.profiles, "openai:setup-old");
      return mocks.authProfileStore;
    });
    runProviderAuth.mockImplementationOnce(async () => {
      mocks.authProfileStore.profiles["openai:setup-old"] = {
        type: "oauth",
        provider: "openai",
        access: "reassigned-access",
        refresh: "reassigned-refresh",
        expires: Date.now() + 60_000,
        accountId: "acct-reassigned",
      };
      return {
        profiles: [
          {
            profileId: "openai:setup-new",
            credential: {
              type: "oauth" as const,
              provider: "openai",
              access: "new-access",
              refresh: "new-refresh",
              expires: Date.now() + 60_000,
              accountId: "acct-old",
            },
          },
        ],
      };
    });
    const matchesPersonalAccount: NonNullable<
      ProviderPlugin["auth"][number]["matchesPersonalAccount"]
    > = (credential, existing) =>
      credential.type === "oauth" &&
      existing.type === "oauth" &&
      credential.provider === existing.provider &&
      credential.accountId === existing.accountId;
    mocks.resolvePluginProvidersCore.mockReturnValue([
      createProvider({
        id: "openai",
        run: runProviderAuth,
        auth: [
          {
            id: "oauth",
            label: "OAuth",
            kind: "oauth",
            run: runProviderAuth,
            matchesPersonalAccount,
          },
        ],
      }),
    ]);

    await expect(
      runModelsAuthLoginFlowCore({
        provider: "openai",
        force: true,
        runtime: createRuntime(),
        prompter: mocks.createClackPrompter(),
      }),
    ).rejects.toThrow("existing auth profile identity changed during sign-in");
  });

  it("does not collapse multiple returned profiles onto one existing account id", async () => {
    mocks.authProfileStore = {
      version: 1,
      profiles: {
        "openai:old": {
          type: "oauth",
          provider: "openai",
          access: "old-access",
          refresh: "old-refresh",
          expires: Date.now() - 60_000,
          accountId: "acct-same",
        },
      },
    };
    runProviderAuth.mockResolvedValueOnce({
      profiles: ["one", "two"].map((suffix) => ({
        profileId: `openai:${suffix}`,
        credential: {
          type: "oauth" as const,
          provider: "openai",
          access: `${suffix}-access`,
          refresh: `${suffix}-refresh`,
          expires: Date.now() + 60_000,
          accountId: "acct-same",
        },
      })),
    });
    const matchesPersonalAccount: NonNullable<
      ProviderPlugin["auth"][number]["matchesPersonalAccount"]
    > = (credential, existing) =>
      credential.type === "oauth" &&
      existing.type === "oauth" &&
      credential.provider === existing.provider &&
      credential.accountId === existing.accountId;
    mocks.resolvePluginProvidersCore.mockReturnValue([
      createProvider({
        id: "openai",
        run: runProviderAuth as ProviderPlugin["auth"][number]["run"],
        auth: [
          {
            id: "oauth",
            label: "OAuth",
            kind: "oauth",
            run: runProviderAuth as ProviderPlugin["auth"][number]["run"],
            matchesPersonalAccount,
          },
        ],
      }),
    ]);

    await runModelsAuthLoginFlowCore({
      provider: "openai",
      runtime: createRuntime(),
      prompter: mocks.createClackPrompter(),
    });

    expect(
      mocks.persistProviderAuthProfilesAfterLogin.mock.calls.map(
        ([call]) => (call as PersistProviderAuthCall).profiles?.[0]?.profileId,
      ),
    ).toEqual(["openai:one", "openai:two"]);
  });

  it("does not reuse an existing profile id when any account matcher throws", async () => {
    mocks.authProfileStore = {
      version: 1,
      profiles: {
        "openai:matching": {
          type: "oauth",
          provider: "openai",
          access: "matching-access",
          refresh: "matching-refresh",
          expires: Date.now() + 60_000,
          accountId: "acct-same",
        },
        "openai:unknown": {
          type: "oauth",
          provider: "openai",
          access: "unknown-access",
          refresh: "unknown-refresh",
          expires: Date.now() + 60_000,
          accountId: "acct-unknown",
        },
      },
    };
    runProviderAuth.mockResolvedValueOnce({
      profiles: [
        {
          profileId: "openai:new",
          credential: {
            type: "oauth",
            provider: "openai",
            access: "new-access",
            refresh: "new-refresh",
            expires: Date.now() + 60_000,
            accountId: "acct-same",
          },
        },
      ],
    });
    const matchesPersonalAccount = vi.fn((credential, existing) => {
      if (existing.accountId === "acct-unknown") {
        throw new Error("identity unavailable");
      }
      return credential.accountId === existing.accountId;
    });
    mocks.resolvePluginProvidersCore.mockReturnValue([
      createProvider({
        id: "openai",
        run: runProviderAuth,
        auth: [
          {
            id: "oauth",
            label: "OAuth",
            kind: "oauth",
            run: runProviderAuth as ProviderPlugin["auth"][number]["run"],
            matchesPersonalAccount,
          },
        ],
      }),
    ]);

    await runModelsAuthLoginFlowCore({
      provider: "openai",
      runtime: createRuntime(),
      prompter: mocks.createClackPrompter(),
    });

    expect(
      (readMockCallArg(mocks.persistProviderAuthProfilesAfterLogin) as PersistProviderAuthCall)
        .profiles?.[0]?.profileId,
    ).toBe("openai:new");
  });

  it("rejects reuse when the matched profile identity changes before persistence", async () => {
    mocks.authProfileStore = {
      version: 1,
      profiles: {
        "openai:old": {
          type: "oauth",
          provider: "openai",
          access: "old-access",
          refresh: "old-refresh",
          expires: Date.now() + 60_000,
          accountId: "acct-same",
        },
      },
    };
    runProviderAuth.mockImplementationOnce(async () => {
      mocks.authProfileStore.profiles["openai:old"] = {
        type: "oauth",
        provider: "openai",
        access: "reassigned-access",
        refresh: "reassigned-refresh",
        expires: Date.now() + 60_000,
        accountId: "acct-reassigned",
      };
      return {
        profiles: [
          {
            profileId: "openai:new",
            credential: {
              type: "oauth" as const,
              provider: "openai",
              access: "new-access",
              refresh: "new-refresh",
              expires: Date.now() + 60_000,
              accountId: "acct-same",
            },
          },
        ],
      };
    });
    const matchesPersonalAccount: NonNullable<
      ProviderPlugin["auth"][number]["matchesPersonalAccount"]
    > = (credential, existing) =>
      credential.type === "oauth" &&
      existing.type === "oauth" &&
      credential.accountId === existing.accountId;
    mocks.resolvePluginProvidersCore.mockReturnValue([
      createProvider({
        id: "openai",
        run: runProviderAuth,
        auth: [
          {
            id: "oauth",
            label: "OAuth",
            kind: "oauth",
            run: runProviderAuth as ProviderPlugin["auth"][number]["run"],
            matchesPersonalAccount,
          },
        ],
      }),
    ]);

    await expect(
      runModelsAuthLoginFlowCore({
        provider: "openai",
        runtime: createRuntime(),
        prompter: mocks.createClackPrompter(),
      }),
    ).rejects.toThrow("existing auth profile identity changed during sign-in");
  });
});
