import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { ProviderPlugin } from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  clackCancel: vi.fn(),
  clackConfirm: vi.fn(),
  clackIsCancel: vi.fn((value: unknown) => value === Symbol.for("clack:cancel")),
  clackSelect: vi.fn(),
  clackText: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
  resolveAgentDir: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveDefaultAgentWorkspaceDir: vi.fn(),
  upsertAuthProfile: vi.fn(),
  resolvePluginProviders: vi.fn(),
  createClackPrompter: vi.fn(),
  loadValidConfigOrThrow: vi.fn(),
  updateConfig: vi.fn(),
  logConfigUpdated: vi.fn(),
  openUrl: vi.fn(),
  loadAuthProfileStoreForRuntime: vi.fn(),
  listProfilesForProvider: vi.fn(),
  clearAuthProfileCooldown: vi.fn(),
}));

vi.mock("../../agents/auth-profiles.js", () => ({
  loadAuthProfileStoreForRuntime: mocks.loadAuthProfileStoreForRuntime,
  listProfilesForProvider: mocks.listProfilesForProvider,
  clearAuthProfileCooldown: mocks.clearAuthProfileCooldown,
  upsertAuthProfile: mocks.upsertAuthProfile,
}));

vi.mock("@clack/prompts", () => ({
  cancel: mocks.clackCancel,
  confirm: mocks.clackConfirm,
  isCancel: mocks.clackIsCancel,
  select: mocks.clackSelect,
  text: mocks.clackText,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
  resolveAgentDir: mocks.resolveAgentDir,
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
}));

vi.mock("../../agents/workspace.js", () => ({
  resolveDefaultAgentWorkspaceDir: mocks.resolveDefaultAgentWorkspaceDir,
}));

vi.mock("../../plugins/providers.js", () => ({
  resolvePluginProviders: mocks.resolvePluginProviders,
}));

vi.mock("../../wizard/clack-prompter.js", () => ({
  createClackPrompter: mocks.createClackPrompter,
}));

vi.mock("./shared.js", async (importActual) => {
  const actual = await importActual<typeof import("./shared.js")>();
  return {
    ...actual,
    loadValidConfigOrThrow: mocks.loadValidConfigOrThrow,
    updateConfig: mocks.updateConfig,
  };
});

vi.mock("../../config/logging.js", () => ({
  logConfigUpdated: mocks.logConfigUpdated,
}));

vi.mock("../onboard-helpers.js", () => ({
  openUrl: mocks.openUrl,
}));

const { modelsAuthLoginCommand, modelsAuthPasteTokenCommand, modelsAuthSetupTokenCommand } =
  await import("./auth.js");

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function withInteractiveStdin() {
  const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
  const hadOwnIsTTY = Object.prototype.hasOwnProperty.call(stdin, "isTTY");
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
  run: NonNullable<ProviderPlugin["auth"]>[number]["run"];
}): ProviderPlugin {
  return {
    id: params.id,
    label: params.label ?? params.id,
    auth: [
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
  let runProviderAuth: ReturnType<typeof vi.fn>;

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
    mocks.clackSelect.mockReset();
    mocks.clackText.mockReset();
    mocks.upsertAuthProfile.mockReset();

    mocks.resolveDefaultAgentId.mockReturnValue("main");
    mocks.resolveAgentDir.mockReturnValue("/tmp/openclaw/agents/main");
    mocks.resolveAgentWorkspaceDir.mockReturnValue("/tmp/openclaw/workspace");
    mocks.resolveDefaultAgentWorkspaceDir.mockReturnValue("/tmp/openclaw/workspace");
    mocks.loadValidConfigOrThrow.mockImplementation(async () => currentConfig);
    mocks.updateConfig.mockImplementation(
      async (mutator: (cfg: OpenClawConfig) => OpenClawConfig) => {
        lastUpdatedConfig = mutator(currentConfig);
        currentConfig = lastUpdatedConfig;
        return lastUpdatedConfig;
      },
    );
    mocks.createClackPrompter.mockReturnValue({
      note: vi.fn(async () => {}),
      select: vi.fn(),
    });
    runProviderAuth = vi.fn().mockResolvedValue({
      profiles: [
        {
          profileId: "openai-codex:user@example.com",
          credential: {
            type: "oauth",
            provider: "openai-codex",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
            email: "user@example.com",
          },
        },
      ],
      defaultModel: "openai-codex/gpt-5.4",
    });
    mocks.resolvePluginProviders.mockReturnValue([
      createProvider({
        id: "openai-codex",
        label: "OpenAI Codex",
        run: runProviderAuth as ProviderPlugin["auth"][number]["run"],
      }),
    ]);
    mocks.loadAuthProfileStoreForRuntime.mockReturnValue({ profiles: {}, usageStats: {} });
    mocks.listProfilesForProvider.mockReturnValue([]);
    mocks.clearAuthProfileCooldown.mockResolvedValue(undefined);
  });

  afterEach(() => {
    restoreStdin?.();
    restoreStdin = null;
  });

  it("runs plugin-owned openai-codex login", async () => {
    const runtime = createRuntime();

    await modelsAuthLoginCommand({ provider: "openai-codex" }, runtime);

    expect(runProviderAuth).toHaveBeenCalledOnce();
    expect(mocks.upsertAuthProfile).toHaveBeenCalledWith({
      profileId: "openai-codex:user@example.com",
      credential: expect.objectContaining({
        type: "oauth",
        provider: "openai-codex",
      }),
      agentDir: "/tmp/openclaw/agents/main",
    });
    expect(lastUpdatedConfig?.auth?.profiles?.["openai-codex:user@example.com"]).toMatchObject({
      provider: "openai-codex",
      mode: "oauth",
    });
    expect(runtime.log).toHaveBeenCalledWith(
      "Auth profile: openai-codex:user@example.com (openai-codex/oauth)",
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "Default model available: openai-codex/gpt-5.4 (use --set-default to apply)",
    );
  });

  it("applies openai-codex default model when --set-default is used", async () => {
    const runtime = createRuntime();

    await modelsAuthLoginCommand({ provider: "openai-codex", setDefault: true }, runtime);

    expect(lastUpdatedConfig?.agents?.defaults?.model).toEqual({
      primary: "openai-codex/gpt-5.4",
    });
    expect(runtime.log).toHaveBeenCalledWith("Default model set to openai-codex/gpt-5.4");
  });

  it("clears stale auth lockouts before attempting openai-codex login", async () => {
    const runtime = createRuntime();
    const fakeStore = {
      profiles: {
        "openai-codex:user@example.com": {
          type: "oauth",
          provider: "openai-codex",
        },
      },
      usageStats: {
        "openai-codex:user@example.com": {
          disabledUntil: Date.now() + 3_600_000,
          disabledReason: "auth_permanent",
          errorCount: 3,
        },
      },
    };
    mocks.loadAuthProfileStoreForRuntime.mockReturnValue(fakeStore);
    mocks.listProfilesForProvider.mockReturnValue(["openai-codex:user@example.com"]);

    await modelsAuthLoginCommand({ provider: "openai-codex" }, runtime);

    expect(mocks.clearAuthProfileCooldown).toHaveBeenCalledWith({
      store: fakeStore,
      profileId: "openai-codex:user@example.com",
      agentDir: "/tmp/openclaw/agents/main",
    });
    // Verify clearing happens before login attempt
    const clearOrder = mocks.clearAuthProfileCooldown.mock.invocationCallOrder[0];
    const loginOrder = runProviderAuth.mock.invocationCallOrder[0];
    expect(clearOrder).toBeLessThan(loginOrder);
  });

  it("survives lockout clearing failure without blocking login", async () => {
    const runtime = createRuntime();
    mocks.loadAuthProfileStoreForRuntime.mockImplementation(() => {
      throw new Error("corrupt auth-profiles.json");
    });

    await modelsAuthLoginCommand({ provider: "openai-codex" }, runtime);

    expect(runProviderAuth).toHaveBeenCalledOnce();
  });

  it("loads lockout state from the agent-scoped store", async () => {
    const runtime = createRuntime();
    mocks.loadAuthProfileStoreForRuntime.mockReturnValue({ profiles: {}, usageStats: {} });
    mocks.listProfilesForProvider.mockReturnValue([]);

    await modelsAuthLoginCommand({ provider: "openai-codex" }, runtime);

    expect(mocks.loadAuthProfileStoreForRuntime).toHaveBeenCalledWith("/tmp/openclaw/agents/main");
  });

  it("reports loaded plugin providers when requested provider is unavailable", async () => {
    const runtime = createRuntime();

    await expect(modelsAuthLoginCommand({ provider: "anthropic" }, runtime)).rejects.toThrow(
      'Unknown provider "anthropic". Loaded providers: openai-codex. Verify plugins via `openclaw plugins list --json`.',
    );
  });

  it("does not persist a cancelled manual token entry", async () => {
    const runtime = createRuntime();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`exit:${String(code ?? "")}`);
    }) as typeof process.exit);
    try {
      const cancelSymbol = Symbol.for("clack:cancel");
      mocks.clackText.mockResolvedValue(cancelSymbol);
      mocks.clackIsCancel.mockImplementation((value: unknown) => value === cancelSymbol);

      await expect(modelsAuthPasteTokenCommand({ provider: "openai" }, runtime)).rejects.toThrow(
        "exit:0",
      );

      expect(mocks.upsertAuthProfile).not.toHaveBeenCalled();
      expect(mocks.updateConfig).not.toHaveBeenCalled();
      expect(mocks.logConfigUpdated).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("uses --token directly and skips interactive prompt", async () => {
    const runtime = createRuntime();

    await modelsAuthPasteTokenCommand(
      { provider: "anthropic", token: "sk-ant-test-token-123" },
      runtime,
    );

    expect(mocks.clackText).not.toHaveBeenCalled();
    expect(mocks.upsertAuthProfile).toHaveBeenCalledWith({
      profileId: "anthropic:manual",
      credential: {
        type: "token",
        provider: "anthropic",
        token: "sk-ant-test-token-123",
      },
    });
    expect(mocks.updateConfig).toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith("Auth profile: anthropic:manual (anthropic/token)");
  });

  it("throws when no TTY and no --token provided", async () => {
    const runtime = createRuntime();
    const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
    const savedDescriptor = Object.getOwnPropertyDescriptor(stdin, "isTTY");
    Object.defineProperty(stdin, "isTTY", {
      configurable: true,
      enumerable: true,
      get: () => false,
    });
    try {
      await expect(modelsAuthPasteTokenCommand({ provider: "anthropic" }, runtime)).rejects.toThrow(
        "paste-token requires --token <value> when running in a non-interactive",
      );
      expect(mocks.clackText).not.toHaveBeenCalled();
      expect(mocks.upsertAuthProfile).not.toHaveBeenCalled();
    } finally {
      if (savedDescriptor) {
        Object.defineProperty(stdin, "isTTY", savedDescriptor);
      } else {
        delete (stdin as { isTTY?: boolean }).isTTY;
      }
    }
  });

  it("uses --token with custom --profile-id and --expires-in", async () => {
    const runtime = createRuntime();

    await modelsAuthPasteTokenCommand(
      {
        provider: "openai",
        token: "sk-test-token",
        profileId: "openai:ci",
        expiresIn: "30d",
      },
      runtime,
    );

    expect(mocks.clackText).not.toHaveBeenCalled();
    expect(mocks.upsertAuthProfile).toHaveBeenCalledWith({
      profileId: "openai:ci",
      credential: expect.objectContaining({
        type: "token",
        provider: "openai",
        token: "sk-test-token",
        expires: expect.any(Number),
      }),
    });
    expect(runtime.log).toHaveBeenCalledWith("Auth profile: openai:ci (openai/token)");
  });

  it("runs token auth for any token-capable provider plugin", async () => {
    const runtime = createRuntime();
    const runTokenAuth = vi.fn().mockResolvedValue({
      profiles: [
        {
          profileId: "moonshot:token",
          credential: {
            type: "token",
            provider: "moonshot",
            token: "moonshot-token",
          },
        },
      ],
    });
    mocks.resolvePluginProviders.mockReturnValue([
      {
        id: "moonshot",
        label: "Moonshot",
        auth: [
          {
            id: "setup-token",
            label: "setup-token",
            kind: "token",
            run: runTokenAuth,
          },
        ],
      },
    ]);

    await modelsAuthSetupTokenCommand({ provider: "moonshot", yes: true }, runtime);

    expect(runTokenAuth).toHaveBeenCalledOnce();
    expect(mocks.upsertAuthProfile).toHaveBeenCalledWith({
      profileId: "moonshot:token",
      credential: {
        type: "token",
        provider: "moonshot",
        token: "moonshot-token",
      },
      agentDir: "/tmp/openclaw/agents/main",
    });
  });
});
