import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  listProfilesForProvider: vi.fn(),
  loadModelsConfig: vi.fn(),
  updateConfig: vi.fn(),
}));

vi.mock("../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: mocks.ensureAuthProfileStore,
  listProfilesForProvider: mocks.listProfilesForProvider,
}));

vi.mock("./load-config.js", () => ({
  loadModelsConfig: mocks.loadModelsConfig,
}));

vi.mock("./shared.js", () => ({
  updateConfig: mocks.updateConfig,
}));

const { modelsAuthProfileUseCommand } = await import("./auth-profile.js");

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function createStore(): AuthProfileStore {
  const now = Date.now();
  return {
    version: 1,
    profiles: {
      "openai-codex:work": {
        type: "oauth",
        provider: "openai-codex",
        access: "work-access",
        refresh: "work-refresh",
        expires: now + 60_000,
        email: "work@example.com",
      },
      "openai-codex:personal": {
        type: "oauth",
        provider: "openai-codex",
        access: "personal-access",
        refresh: "personal-refresh",
        expires: now + 60_000,
        email: "personal@example.com",
      },
      "openai-codex:backup": {
        type: "oauth",
        provider: "openai-codex",
        access: "backup-access",
        refresh: "backup-refresh",
        expires: now + 60_000,
        email: "backup@example.com",
      },
      "anthropic:default": {
        type: "api_key",
        provider: "anthropic",
        key: "anthropic-key",
      },
    },
  };
}

describe("modelsAuthProfileUseCommand", () => {
  let runtime: RuntimeEnv;
  let baseConfig: OpenClawConfig;
  let store: AuthProfileStore;

  beforeEach(() => {
    vi.clearAllMocks();
    runtime = createRuntime();
    baseConfig = {
      auth: {
        order: {
          "openai-codex": ["openai-codex:work"],
        },
      },
    };
    store = createStore();

    mocks.loadModelsConfig.mockResolvedValue(baseConfig);
    mocks.ensureAuthProfileStore.mockReturnValue(store);
    mocks.listProfilesForProvider.mockReturnValue([
      "openai-codex:work",
      "openai-codex:personal",
      "openai-codex:backup",
    ]);
    mocks.updateConfig.mockImplementation(
      async (mutator: (cfg: OpenClawConfig) => OpenClawConfig) => mutator(baseConfig),
    );
  });

  it("puts selected profile first and keeps remaining profiles for fallback", async () => {
    store.order = {
      "openai-codex": ["openai-codex:backup"],
    };
    let persisted: OpenClawConfig | undefined;
    mocks.updateConfig.mockImplementation(
      async (mutator: (cfg: OpenClawConfig) => OpenClawConfig) => {
        persisted = mutator(baseConfig);
        return persisted;
      },
    );

    await modelsAuthProfileUseCommand(
      {
        provider: "openai-codex",
        profileId: "openai-codex:personal",
      },
      runtime,
    );

    expect(persisted?.auth?.order?.["openai-codex"]).toEqual([
      "openai-codex:personal",
      "openai-codex:work",
      "openai-codex:backup",
    ]);
  });

  it("throws when profile does not exist", async () => {
    await expect(
      modelsAuthProfileUseCommand(
        {
          provider: "openai-codex",
          profileId: "openai-codex:missing",
        },
        runtime,
      ),
    ).rejects.toThrow('Auth profile "openai-codex:missing" not found');

    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });

  it("throws when selected profile belongs to a different provider", async () => {
    await expect(
      modelsAuthProfileUseCommand(
        {
          provider: "openai-codex",
          profileId: "anthropic:default",
        },
        runtime,
      ),
    ).rejects.toThrow('Auth profile "anthropic:default" is for anthropic, not openai-codex');

    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });

  it("defaults provider to openai-codex when provider option is omitted", async () => {
    let persisted: OpenClawConfig | undefined;
    mocks.updateConfig.mockImplementation(
      async (mutator: (cfg: OpenClawConfig) => OpenClawConfig) => {
        persisted = mutator(baseConfig);
        return persisted;
      },
    );

    await modelsAuthProfileUseCommand(
      {
        profileId: "openai-codex:work",
      },
      runtime,
    );

    expect(persisted?.auth?.order?.["openai-codex"]?.[0]).toBe("openai-codex:work");
  });
});
