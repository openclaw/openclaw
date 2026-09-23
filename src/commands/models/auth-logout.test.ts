// Covers `models auth logout`: store removal, config-reference cleanup, and refusals.
import { expectDefined } from "@openclaw/normalization-core";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileCredential, AuthProfileStore } from "../../agents/auth-profiles.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "../../agents/auth-profiles/credential-fixtures.test-support.js";
import { registerModelsCli } from "../../cli/models-cli.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDirectChatContext } from "../../gateway/server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../../gateway/server-methods.js";
import type { RespondFn } from "../../gateway/server-methods/types.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStoreWithoutExternalProfiles: vi.fn<() => AuthProfileStore>(),
  listProfilesForProvider: vi.fn(() => [] as string[]),
  removeAuthProfilesAcrossOwnerStores: vi.fn(
    async (params: {
      profileIds: readonly string[];
      beforeRemove?: (profileIds: readonly string[]) => Promise<void>;
      onIncomplete?: (
        survivingProfiles: ReadonlyMap<string, AuthProfileCredential>,
      ) => Promise<void>;
    }) => {
      await params.beforeRemove?.(params.profileIds);
      return true;
    },
  ),
  loadModelsConfig: vi.fn(),
  updateConfig: vi.fn(),
  logConfigUpdated: vi.fn(),
  refreshRunningGatewayAuthState: vi.fn(async () => undefined),
  confirm: vi.fn(async () => true),
}));

vi.mock("../../agents/auth-profiles.js", async () => {
  const { clearRuntimeAuthProfileStoreSnapshots } =
    await import("../../agents/auth-profiles/runtime-snapshots.js");
  return {
    clearRuntimeAuthProfileStoreSnapshots,
    ensureAuthProfileStoreWithoutExternalProfiles:
      mocks.ensureAuthProfileStoreWithoutExternalProfiles,
    listProfilesForProvider: mocks.listProfilesForProvider,
    loadAuthProfileStoreWithoutExternalProfiles:
      mocks.ensureAuthProfileStoreWithoutExternalProfiles,
    removeAuthProfilesAcrossOwnerStores: mocks.removeAuthProfilesAcrossOwnerStores,
  };
});

vi.mock("./load-config.js", () => ({
  loadModelsConfig: mocks.loadModelsConfig,
}));

vi.mock("./shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared.js")>();
  return {
    ...actual,
    resolveModelsTargetAgent: (_cfg: OpenClawConfig, rawAgentId?: string) => ({
      agentId: rawAgentId ?? "main",
      agentDir: `/tmp/agent-${rawAgentId ?? "main"}`,
    }),
    updateConfig: mocks.updateConfig,
  };
});

vi.mock("./auth-refresh.js", () => ({
  refreshRunningGatewayAuthState: mocks.refreshRunningGatewayAuthState,
}));

vi.mock("../../gateway/server-methods/models-auth-refresh.js", () => ({
  modelsAuthRefreshHandlers: {},
}));

vi.mock("../../gateway/model-auth-refresh.js", () => ({
  refreshModelAuthStateAfterMutation: vi.fn(async () => undefined),
}));

vi.mock("../../config/logging.js", () => ({
  logConfigUpdated: mocks.logConfigUpdated,
}));

vi.mock("../../wizard/clack-prompter.js", () => ({
  createClackPrompter: () => ({ confirm: mocks.confirm }),
}));

const { modelsAuthLogoutCommand } = await import("./auth-logout.js");

async function runRegisteredLogout(profileId: string): Promise<void> {
  const errors: string[] = [];
  const error = vi.spyOn(defaultRuntime, "error").mockImplementation((message) => {
    errors.push(String(message));
  });
  const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {
    throw new Error(errors.join("\n"));
  });
  try {
    const program = new Command().exitOverride();
    registerModelsCli(program);
    await program.parseAsync(["models", "auth", "logout", profileId, "--yes"], { from: "user" });
  } finally {
    error.mockRestore();
    exit.mockRestore();
  }
}

async function dispatchAuthLogout(
  cfg: OpenClawConfig,
  selection: { profileIds?: string[]; credentialType?: "api_key" },
): Promise<void> {
  mocks.listProfilesForProvider.mockReturnValue(
    Object.keys(mocks.ensureAuthProfileStoreWithoutExternalProfiles().profiles),
  );
  const respond = vi.fn<RespondFn>();
  await handleGatewayRequest({
    req: {
      type: "req",
      id: crypto.randomUUID(),
      method: "models.authLogout",
      params: { provider: "openai", agentId: "main", ...selection },
    },
    respond,
    client: {
      connId: crypto.randomUUID(),
      connect: {
        role: "operator",
        scopes: ["operator.admin"],
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "cli", version: "test", platform: "test", mode: "cli" },
      },
    },
    isWebchatConnect: () => false,
    context: createDirectChatContext({
      getRuntimeConfig: () => ({ ...cfg, agents: { entries: { main: {} } } }),
    }),
  });
  expect(respond).toHaveBeenCalledOnce();
  const [ok, payload, error] = expectDefined(respond.mock.calls[0], "Gateway logout response");
  if (!ok) {
    throw new Error(expectDefined(error, "Gateway logout error").message);
  }
  expect(payload).toHaveProperty(
    "warning",
    "Credentials were removed, but the Gateway has not confirmed applying the change. Run `openclaw gateway restart` to apply it.",
  );
}

function createRuntime(): RuntimeEnv & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    log: (...args: unknown[]) => {
      logs.push(args.map((value) => String(value)).join(" "));
    },
    error: () => {},
    exit: () => {},
  };
}

function storeWith(profileIds: string[]): AuthProfileStore {
  return {
    version: 1,
    profiles: Object.fromEntries(
      profileIds.map((profileId) => [
        profileId,
        {
          type: "oauth" as const,
          provider: profileId.split(":")[0] ?? "openai",
          access: "tok",
          refresh: "refresh",
          expires: 1_000_000,
        },
      ]),
    ),
  };
}

/** Runs the config mutator captured by the mocked updateConfig. */
function applyCapturedConfigUpdate(cfg: OpenClawConfig): OpenClawConfig {
  const mutator = mocks.updateConfig.mock.calls[0]?.[0] as
    | ((current: OpenClawConfig, context: { runtimeConfig: OpenClawConfig }) => OpenClawConfig)
    | undefined;
  if (!mutator) {
    throw new Error("expected updateConfig to be called");
  }
  return mutator(cfg, { runtimeConfig: cfg });
}

async function withStdinIsTty<T>(isTTY: boolean, run: () => Promise<T>): Promise<T> {
  const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
  const hadOwnIsTTY = Object.hasOwn(stdin, "isTTY");
  const previousIsTTYDescriptor = Object.getOwnPropertyDescriptor(stdin, "isTTY");
  Object.defineProperty(stdin, "isTTY", {
    configurable: true,
    value: isTTY,
  });
  try {
    return await run();
  } finally {
    if (hadOwnIsTTY && previousIsTTYDescriptor) {
      Object.defineProperty(stdin, "isTTY", previousIsTTYDescriptor);
    } else {
      Reflect.deleteProperty(stdin, "isTTY");
    }
  }
}

describe("models auth logout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.removeAuthProfilesAcrossOwnerStores.mockImplementation(async (params) => {
      await params.beforeRemove?.(params.profileIds);
      return true;
    });
    mocks.confirm.mockResolvedValue(true);
    mocks.listProfilesForProvider.mockReturnValue([]);
    mocks.updateConfig.mockResolvedValue({} as OpenClawConfig);
    mocks.loadModelsConfig.mockResolvedValue({} as OpenClawConfig);
    mocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue(
      storeWith(["openai:manual"]),
    );
  });

  it("removes the profile from the selected agent store", async () => {
    const runtime = createRuntime();
    await modelsAuthLogoutCommand({ profileId: "openai:manual", agent: "poe", yes: true }, runtime);

    expect(mocks.removeAuthProfilesAcrossOwnerStores).toHaveBeenCalledWith({
      agentDir: "/tmp/agent-poe",
      cfg: {},
      profileIds: ["openai:manual"],
      beforeRemove: expect.any(Function),
      onIncomplete: expect.any(Function),
    });
    expect(mocks.refreshRunningGatewayAuthState).toHaveBeenCalledWith("poe", "logout", runtime);
    expect(runtime.logs).toContain("Removed auth profile: openai:manual (openai/oauth)");
    expect(runtime.logs.some((line) => line.includes("No auth profiles remain for openai"))).toBe(
      true,
    );
    expect(applyCapturedConfigUpdate({})).toEqual({});
  });

  it("drops config auth.profiles and auth.order references to the removed profile", async () => {
    const cfg = {
      auth: {
        profiles: {
          "openai:manual": { provider: "openai", mode: "oauth" },
          "openai:backup": { provider: "openai", mode: "api_key" },
          "anthropic:manual": { provider: "anthropic", mode: "oauth" },
        },
        order: {
          openai: ["openai:manual", "openai:backup"],
          anthropic: ["anthropic:manual"],
        },
      },
    } satisfies OpenClawConfig;
    mocks.loadModelsConfig.mockResolvedValue(cfg);

    await modelsAuthLogoutCommand({ profileId: "openai:manual", yes: true }, createRuntime());

    expect(mocks.updateConfig).toHaveBeenCalledTimes(1);
    expect(applyCapturedConfigUpdate(cfg).auth).toEqual({
      profiles: {
        "openai:backup": { provider: "openai", mode: "api_key" },
        "anthropic:manual": { provider: "anthropic", mode: "oauth" },
      },
      order: {
        openai: ["openai:backup"],
        anthropic: ["anthropic:manual"],
      },
    });
    expect(mocks.logConfigUpdated).toHaveBeenCalledTimes(1);
  });

  it("deletes an emptied provider order but keeps an authored empty one", async () => {
    const cfg = {
      auth: {
        profiles: { "openai:manual": { provider: "openai", mode: "oauth" } },
        order: { openai: ["openai:manual"], anthropic: [] },
      },
    } satisfies OpenClawConfig;
    mocks.loadModelsConfig.mockResolvedValue(cfg);

    await modelsAuthLogoutCommand({ profileId: "openai:manual", yes: true }, createRuntime());

    // `anthropic: []` is an authored "select no profiles" instruction for an
    // unrelated provider; only the order this removal emptied may go.
    expect(applyCapturedConfigUpdate(cfg).auth).toEqual({
      profiles: {},
      order: { anthropic: [] },
    });
  });

  it("removes the config reference before deleting the credential", async () => {
    const cfg = {
      auth: { profiles: { "openai:manual": { provider: "openai", mode: "oauth" } } },
    } satisfies OpenClawConfig;
    mocks.loadModelsConfig.mockResolvedValue(cfg);
    const calls: string[] = [];
    mocks.updateConfig.mockImplementation(async () => {
      calls.push("config");
      return cfg;
    });
    mocks.removeAuthProfilesAcrossOwnerStores.mockImplementation(async (params) => {
      await params.beforeRemove?.(params.profileIds);
      calls.push("store");
      return true;
    });

    await modelsAuthLogoutCommand({ profileId: "openai:manual", yes: true }, createRuntime());

    expect(calls).toEqual(["config", "store"]);
  });

  it.each([
    {
      label: "unknown profile id",
      profileId: "openai:missing",
      cfg: {} as OpenClawConfig,
      expected: 'Auth profile "openai:missing" not found for agent "main"',
    },
    {
      label: "blank profile id",
      profileId: "  ",
      cfg: {} as OpenClawConfig,
      expected: "Missing profile id",
    },
  ])("refuses removal for $label", async ({ profileId, cfg, expected }) => {
    mocks.loadModelsConfig.mockResolvedValue(cfg);

    await expect(
      modelsAuthLogoutCommand({ profileId, yes: true }, createRuntime()),
    ).rejects.toThrow(expected);
    expect(mocks.removeAuthProfilesAcrossOwnerStores).not.toHaveBeenCalled();
  });

  it("clears a provider binding before removing its key, preserving model selection", async () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: "openai/current" } },
      models: {
        providers: {
          openai: { baseUrl: "https://example.test/v1", models: [], apiKey: "openai:manual" },
        },
      },
    };
    mocks.loadModelsConfig.mockResolvedValue(cfg);
    await modelsAuthLogoutCommand({ profileId: "openai:manual", yes: true }, createRuntime());
    const updated = applyCapturedConfigUpdate(cfg);
    expect(updated.models?.providers?.openai?.apiKey).toBeUndefined();
    expect(updated.agents).toEqual(cfg.agents);
    expect(mocks.removeAuthProfilesAcrossOwnerStores).toHaveBeenCalledOnce();
  });

  it("fails when the auth store update does not complete", async () => {
    mocks.removeAuthProfilesAcrossOwnerStores.mockResolvedValue(false);

    await expect(
      modelsAuthLogoutCommand({ profileId: "openai:manual", yes: true }, createRuntime()),
    ).rejects.toThrow("Saved credentials could not be removed");
  });

  it.each([
    { name: "returns incomplete", failure: new Error("incomplete"), throws: false },
    { name: "throws", failure: new Error("store write failed"), throws: true },
  ])("restores surviving config when store removal $name", async ({ failure, throws }) => {
    const profileId = "openai:manual";
    const credential: AuthProfileCredential = createApiKeyCredential("openai", "synthetic-key");
    let liveConfig: OpenClawConfig = {
      auth: {
        profiles: { [profileId]: { provider: "openai", mode: "api_key" } },
        order: { openai: [profileId] },
      },
      models: {
        providers: {
          openai: { baseUrl: "https://example.test/v1", models: [], apiKey: profileId },
        },
      },
    };
    mocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue(
      createAuthProfileStoreFixture({ [profileId]: credential }),
    );
    mocks.updateConfig.mockImplementation(
      async (
        mutator: (
          current: OpenClawConfig,
          context: { runtimeConfig: OpenClawConfig },
        ) => OpenClawConfig | Promise<OpenClawConfig>,
      ) => {
        liveConfig = await mutator(liveConfig, { runtimeConfig: liveConfig });
        return liveConfig;
      },
    );
    mocks.removeAuthProfilesAcrossOwnerStores.mockImplementationOnce(async (params) => {
      await params.beforeRemove?.(params.profileIds);
      await params.onIncomplete?.(new Map([[profileId, credential]]));
      if (throws) {
        throw failure;
      }
      return false;
    });

    mocks.loadModelsConfig.mockImplementation(async () => liveConfig);
    await expect(runRegisteredLogout(profileId)).rejects.toThrow(
      throws ? "store write failed" : "could not be removed",
    );

    expect(liveConfig.auth?.profiles?.[profileId]).toEqual({
      provider: "openai",
      mode: "api_key",
    });
    expect(liveConfig.auth?.order?.openai).toEqual([profileId]);
    expect(liveConfig.models?.providers?.openai?.apiKey).toBe(profileId);
  });

  it("restores only surviving references after partial multi-store removal", async () => {
    const removedId = "openai:removed";
    const survivorId = "openai:survivor";
    const survivor: AuthProfileCredential = createApiKeyCredential("openai", "synthetic-survivor");
    let liveConfig: OpenClawConfig = {
      auth: {
        profiles: {
          [removedId]: { provider: "openai", mode: "api_key" },
          [survivorId]: { provider: "openai", mode: "api_key" },
        },
        order: { openai: [removedId, survivorId] },
      },
      models: {
        providers: {
          openai: { baseUrl: "https://example.test/v1", models: [], apiKey: survivorId },
        },
      },
    };
    mocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue(
      createAuthProfileStoreFixture({
        [removedId]: { ...survivor, key: "synthetic-removed" },
        [survivorId]: survivor,
      }),
    );
    mocks.updateConfig.mockImplementation(
      async (
        mutator: (
          current: OpenClawConfig,
          context: { runtimeConfig: OpenClawConfig },
        ) => OpenClawConfig | Promise<OpenClawConfig>,
      ) => {
        liveConfig = await mutator(liveConfig, { runtimeConfig: liveConfig });
        return liveConfig;
      },
    );
    mocks.removeAuthProfilesAcrossOwnerStores
      .mockReset()
      .mockImplementationOnce(async (params) => {
        await params.beforeRemove?.(params.profileIds);
        mocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue(
          createAuthProfileStoreFixture({ [survivorId]: survivor }),
        );
        await params.onIncomplete?.(new Map([[survivorId, survivor]]));
        return false;
      })
      .mockImplementationOnce(async (params) => {
        await params.beforeRemove?.(params.profileIds);
        mocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue(
          createAuthProfileStoreFixture({}),
        );
        return true;
      });

    await expect(
      dispatchAuthLogout(liveConfig, { profileIds: [removedId, survivorId] }),
    ).rejects.toThrow("could not be removed");

    expect(liveConfig.auth?.profiles).toEqual({
      [survivorId]: { provider: "openai", mode: "api_key" },
    });
    expect(liveConfig.auth?.order?.openai).toEqual([survivorId]);
    expect(liveConfig.models?.providers?.openai?.apiKey).toBe(survivorId);

    await dispatchAuthLogout(liveConfig, { profileIds: [survivorId] });
    expect(liveConfig.auth?.profiles).toEqual({});
    expect(liveConfig.auth?.order).toBeUndefined();
    expect(liveConfig.models?.providers?.openai?.apiKey).toBeUndefined();
  });

  it("preserves an untargeted token binding through failed API-key removal and retry", async () => {
    const keyId = "openai:key";
    const tokenId = "openai:token";
    const key: AuthProfileCredential = createApiKeyCredential("openai", "synthetic-key");
    const token: AuthProfileCredential = {
      type: "token",
      provider: "openai",
      token: "synthetic-token",
    };
    let liveConfig: OpenClawConfig = {
      auth: {
        profiles: {
          [keyId]: { provider: "openai", mode: "api_key" },
          [tokenId]: { provider: "openai", mode: "token" },
        },
        order: { openai: [keyId, tokenId] },
      },
      models: {
        providers: {
          openai: { baseUrl: "https://example.test/v1", models: [], apiKey: tokenId },
        },
      },
    };
    mocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue(
      createAuthProfileStoreFixture({ [keyId]: key, [tokenId]: token }),
    );
    mocks.updateConfig.mockImplementation(
      async (
        mutator: (
          current: OpenClawConfig,
          context: { runtimeConfig: OpenClawConfig },
        ) => OpenClawConfig | Promise<OpenClawConfig>,
      ) => {
        liveConfig = await mutator(liveConfig, { runtimeConfig: liveConfig });
        return liveConfig;
      },
    );
    mocks.removeAuthProfilesAcrossOwnerStores
      .mockReset()
      .mockImplementationOnce(async (params) => {
        await params.beforeRemove?.(params.profileIds);
        await params.onIncomplete?.(new Map([[keyId, key]]));
        return false;
      })
      .mockImplementationOnce(async (params) => {
        await params.beforeRemove?.(params.profileIds);
        mocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue(
          createAuthProfileStoreFixture({ [tokenId]: token }),
        );
        return true;
      });

    await expect(dispatchAuthLogout(liveConfig, { credentialType: "api_key" })).rejects.toThrow(
      "could not be removed",
    );
    expect(liveConfig.auth?.profiles).toEqual({
      [keyId]: { provider: "openai", mode: "api_key" },
      [tokenId]: { provider: "openai", mode: "token" },
    });
    expect(liveConfig.auth?.order?.openai).toEqual([keyId, tokenId]);
    expect(liveConfig.models?.providers?.openai?.apiKey).toBe(tokenId);

    await dispatchAuthLogout(liveConfig, { credentialType: "api_key" });
    expect(liveConfig.auth?.profiles).toEqual({
      [tokenId]: { provider: "openai", mode: "token" },
    });
    expect(liveConfig.auth?.order?.openai).toEqual([tokenId]);
    expect(liveConfig.models?.providers?.openai?.apiKey).toBe(tokenId);
  });

  it("keeps the profile when an interactive confirmation is declined", async () => {
    mocks.confirm.mockResolvedValue(false);
    await withStdinIsTty(true, async () => {
      const runtime = createRuntime();
      await modelsAuthLogoutCommand({ profileId: "openai:manual" }, runtime);
      expect(mocks.removeAuthProfilesAcrossOwnerStores).not.toHaveBeenCalled();
      expect(runtime.logs).toContain("Cancelled.");
    });
  });

  it("refuses to remove without --yes when stdin is not a TTY", async () => {
    await withStdinIsTty(false, async () => {
      await expect(
        modelsAuthLogoutCommand({ profileId: "openai:manual" }, createRuntime()),
      ).rejects.toThrow("Pass --yes to remove it non-interactively.");
      expect(mocks.removeAuthProfilesAcrossOwnerStores).not.toHaveBeenCalled();
    });
  });
});
