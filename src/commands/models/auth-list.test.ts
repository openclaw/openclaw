import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
  createOAuthRefreshCredential,
} from "../../agents/auth-profiles/credential-fixtures.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createRuntimeEnv } from "../../test-utils/plugin-runtime-env.js";
import { modelsAuthListCommand } from "./auth-list.js";
import { modelsAuthOrderGetCommand, modelsAuthOrderUpdateCommand } from "./auth-order.js";
import { listUnavailableAuthProfiles } from "./auth-unavailability.js";

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  setAuthProfileOrder: vi.fn(),
  refreshRunningGatewayAuthState: vi.fn(async () => undefined),
  externalCliDiscoveryForProviderAuth: vi.fn(() => ({ kind: "none" })),
  loadModelsConfig: vi.fn(),
  resolveAuthProfileDisplayLabel: vi.fn(({ profileId }: { profileId: string }) => profileId),
  resolveAuthStatePathForDisplay: vi.fn((agentDir: string) => `${agentDir}/openclaw-agent.sqlite`),
  resolveModelsTargetAgent: vi.fn((_cfg: OpenClawConfig, rawAgentId?: string) => {
    const agentId = rawAgentId ?? "main";
    return { agentDir: `/tmp/openclaw/agents/${agentId}`, agentId };
  }),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentDir: (_cfg: OpenClawConfig, agentId: string) => `/tmp/openclaw/agents/${agentId}`,
  resolveDefaultAgentId: () => "main",
}));

// mock-isolation: Listing formats synthetic profiles without reading host stores or external CLIs.
vi.mock("../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStoreAsync: async (...args: unknown[]) => mocks.ensureAuthProfileStore(...args),
  setAuthProfileOrder: mocks.setAuthProfileOrder,
  externalCliDiscoveryForProviderAuth: mocks.externalCliDiscoveryForProviderAuth,
  resolveAuthProfileDisplayLabel: mocks.resolveAuthProfileDisplayLabel,
  resolveAuthStatePathForDisplay: mocks.resolveAuthStatePathForDisplay,
}));

// mock-isolation: Use fixture config without reading host config or resolving its secrets.
vi.mock("./load-config.js", () => ({ loadModelsConfig: mocks.loadModelsConfig }));
// mock-isolation: Resolve only the synthetic agent directories owned by this suite.
vi.mock("./shared.js", () => ({ resolveModelsTargetAgent: mocks.resolveModelsTargetAgent }));
vi.mock("./auth-refresh.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth-refresh.js")>()),
  refreshRunningGatewayAuthState: mocks.refreshRunningGatewayAuthState,
}));

const NOW = Date.parse("2026-08-30T00:00:00.000Z");

async function list(options: Parameters<typeof modelsAuthListCommand>[0] = {}) {
  const runtime = createRuntimeEnv();
  await modelsAuthListCommand(options, runtime);
  return {
    logs: vi.mocked(runtime.log).mock.calls.map((args) => args.map(String).join(" ")),
    jsonPayloads: vi.mocked(runtime.writeJson).mock.calls.map(([value]) => value),
  };
}

async function listBoth() {
  return { text: (await list()).logs, json: (await list({ json: true })).jsonPayloads[0] };
}

function expectProfile(json: unknown, profile: Record<string, unknown>) {
  expect(json).toMatchObject({ profiles: [expect.objectContaining(profile)] });
}

function summary(id: string, type: string, fields = {}) {
  return { id, label: id, provider: id.split(":")[0], type, ...fields };
}

function setOAuthProfile(
  id: string,
  provider: string,
  usage: NonNullable<AuthProfileStore["usageStats"]>[string],
) {
  mocks.ensureAuthProfileStore.mockReturnValue({
    ...createAuthProfileStoreFixture({
      [id]: createOAuthRefreshCredential({
        provider,
        access: "secret",
        refresh: "secret",
        expires: 1_900_000_000_000,
      }),
    }),
    usageStats: { [id]: usage },
  } satisfies AuthProfileStore);
}

const block = (
  blockedUntil: number,
  fields: NonNullable<AuthProfileStore["usageStats"]>[string] = {},
) => ({
  blockedUntil,
  blockedReason: "subscription_limit" as const,
  blockedSource: "wham" as const,
  ...fields,
});

describe("modelsAuthListCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadModelsConfig.mockReset().mockResolvedValue({} as OpenClawConfig);
    mocks.ensureAuthProfileStore.mockReset();
    mocks.resolveAuthStatePathForDisplay
      .mockReset()
      .mockImplementation((agentDir: string) => `${agentDir}/openclaw-agent.sqlite`);
  });

  afterEach(() => vi.restoreAllMocks());

  it("escapes profile labels, model blocks and store paths only in terminal output", async () => {
    const profileId = "openai:café\x1b[31m\nforged\tprofile\r\x00\x85";
    const model = "café\x1b[2J\nforged-model";
    setOAuthProfile(
      profileId,
      "openai",
      block(1_900_000_100_000, { blockedModel: model, blockedScope: "model" }),
    );
    mocks.resolveAuthStatePathForDisplay.mockReturnValue("/tmp/café\x1b[31m\nstore.sqlite");
    const { text, json } = await listBoth();

    expect(text[1]).toBe("Auth state store: /tmp/café\\nstore.sqlite");
    expect(text.at(-1)).toContain("- openai:café\\nforged\\tprofile\\r [openai/oauth;");
    expect(text.at(-1)).toContain("for model café\\nforged-model until");
    expect(text.join("")).not.toMatch(/\p{Cc}/u);
    expectProfile(json, { id: profileId, label: profileId, blockedModel: model });
    expect(json).toMatchObject({ authStatePath: "/tmp/café\x1b[31m\nstore.sqlite" });
  });

  it.each([false, true])(
    "projects managed health without transient cooldowns (disabled=%s)",
    async (disabled) => {
      const snapshot = createPluginMetadataSnapshotFixture({
        plugins: [{ id: "gateway", providers: ["my-gateway"], managesOwnAvailability: true }],
      });
      const window = {
        cooldownUntil: 1_900_003_100_000,
        cooldownReason: "rate_limit" as const,
        ...(disabled
          ? { disabledUntil: 1_900_000_100_000, disabledReason: "billing" as const }
          : {}),
      };
      mocks.ensureAuthProfileStore.mockReturnValue({
        version: 1,
        profiles: { "my-gateway:manual": createApiKeyCredential("my-gateway", "synthetic-key") },
        usageStats: { "my-gateway:manual": window },
      } satisfies AuthProfileStore);
      const { text, json } = await withPluginMetadataSnapshotScope(
        snapshot,
        async () => {
          if (disabled) {
            expect(listUnavailableAuthProfiles(mocks.ensureAuthProfileStore())).toEqual([
              expect.objectContaining({
                profileId: "my-gateway:manual",
                kind: "disabled",
                reason: "billing",
                until: 1_900_000_100_000,
              }),
            ]);
          }
          return listBoth();
        },
        { trustConfigIdentity: true },
      );
      const identity = summary("my-gateway:manual", "api_key");
      expectProfile(json, { ...identity, ...(disabled ? { disabledReason: "billing" } : {}) });
      expect(text.at(-1)).not.toContain("cooldown");
      expect(json).not.toMatchObject({
        profiles: [expect.objectContaining({ cooldownUntil: expect.anything() })],
      });
      if (disabled) {
        expect(text.at(-1)).toContain("disabled:billing");
      } else {
        expect(text.at(-1)).toBe("- my-gateway:manual [my-gateway/api_key]");
      }
    },
  );

  it("shows exact WHAM classification without hiding the canonical reason in JSON", async () => {
    setOAuthProfile("openai:expired", "openai", {
      cooldownUntil: 1_900_000_100_000,
      cooldownReason: "auth",
      cooldownClassification: "wham_token_expired",
    });
    const { text, json } = await listBoth();
    expect(text.at(-1)).toContain("cooldown:wham_token_expired");
    expect(text.at(-1)).toContain("openclaw models auth login --provider openai");
    expectProfile(json, {
      cooldownReason: "auth",
      cooldownClassification: "wham_token_expired",
      recoveryHint:
        "Re-authenticate with `openclaw models auth login --provider openai --profile-id 'openai:expired'`.",
    });
  });

  it("projects only active subscription blocks in text and JSON", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const profile = { type: "api_key", provider: "openai", key: "credential-secret" } as const;
    const usageStats = {
      "openai:profile-wide": block(NOW + 60_000, {
        blockedSource: "codex_rate_limits",
        blockedModel: "legacy-model-must-not-leak",
      }),
      "openai:model-scoped": block(NOW + 120_000, {
        blockedModel: "gpt-5.5",
        blockedScope: "model",
      }),
      "openai:model-scope-without-model": block(NOW + 180_000, { blockedScope: "model" }),
      "openai:expired": block(NOW - 1, {
        blockedSource: "codex_rate_limits",
        blockedModel: "gpt-expired",
        blockedScope: "model",
      }),
      "openai:invalid": block(8_700_000_000_000_000, {
        blockedModel: "gpt-invalid",
        blockedScope: "model",
      }),
    };
    mocks.ensureAuthProfileStore.mockReturnValue({
      ...createAuthProfileStoreFixture(
        Object.fromEntries(Object.keys(usageStats).map((id) => [id, profile])),
      ),
      usageStats,
    } satisfies AuthProfileStore);

    const { text, json } = await listBoth();
    const { profiles } = json as { profiles: Array<Record<string, unknown> & { id: string }> };
    const byId = Object.fromEntries(profiles.map((entry) => [entry.id, entry]));
    function expectBlock(id: string, until: string, source: string, model?: string) {
      const scope = model ? `model ${model}` : "profile";
      expect(text.find((line) => line.includes(id))).toContain(
        `blocked:subscription_limit via ${source} for ${scope} until ${until}`,
      );
      expect(byId[id]).toMatchObject({
        blockedUntil: until,
        blockedReason: "subscription_limit",
        blockedSource: source,
        blockedScope: model ? "model" : "profile",
        ...(model ? { blockedModel: model } : {}),
      });
      if (!model) {
        expect(byId[id]).not.toHaveProperty("blockedModel");
      }
    }
    expectBlock("openai:profile-wide", "2026-08-30T00:01:00.000Z", "codex_rate_limits");
    expectBlock("openai:model-scoped", "2026-08-30T00:02:00.000Z", "wham", "gpt-5.5");
    expectBlock("openai:model-scope-without-model", "2026-08-30T00:03:00.000Z", "wham");
    for (const id of ["openai:expired", "openai:invalid"]) {
      expect(text.find((line) => line.includes(id))).not.toContain("blocked:");
      expect(byId[id]).toEqual(summary(id, "api_key"));
    }
    expect(JSON.stringify(json)).not.toMatch(/secret|legacy-model-must-not-leak/u);
  });

  it.each([
    [1_800_000_000_000, { expiresAt: "2027-01-15T08:00:00.000Z" }],
    [8_700_000_000_000_000, {}],
  ] as const)(
    "filters OpenAI profiles and omits invalid timestamps (expires=%s)",
    async (expires, expectedExpiry) => {
      const store: AuthProfileStore = createAuthProfileStoreFixture({
        "openai:user@example.com": createOAuthRefreshCredential({
          access: "access-secret",
          refresh: "refresh-secret",
          expires,
          email: "user@example.com",
        }),
        "openai:api-key-backup": createApiKeyCredential("openai", "sk-secret"),
        "anthropic:manual": { type: "token", provider: "anthropic", token: "token-secret" },
      });
      if (expires === 8_700_000_000_000_000) {
        store.usageStats = { "openai:user@example.com": { cooldownUntil: expires } };
      }
      mocks.ensureAuthProfileStore.mockReturnValue(store);
      const runtime = await list({ provider: "OpenAI", json: true });

      expect(runtime.jsonPayloads).toStrictEqual([
        {
          agentDir: "/tmp/openclaw/agents/main",
          agentId: "main",
          authStatePath: "/tmp/openclaw/agents/main/openclaw-agent.sqlite",
          profiles: [
            summary("openai:api-key-backup", "api_key"),
            summary("openai:user@example.com", "oauth", {
              email: "user@example.com",
              ...expectedExpiry,
            }),
          ],
          provider: "openai",
        },
      ]);
      expect(JSON.stringify(runtime.jsonPayloads[0])).not.toContain("secret");
    },
  );

  it("prints an empty profile list with the actual shared auth path", async () => {
    const authStatePath = "/tmp/openclaw/state/openclaw.sqlite";
    mocks.ensureAuthProfileStore.mockReturnValue({ version: 1, profiles: {} });
    mocks.resolveAuthStatePathForDisplay.mockReturnValue(authStatePath);
    const runtime = await list();

    expect(runtime.logs).toEqual([
      "Agent: main",
      `Auth state store: ${authStatePath}`,
      "Profiles: (none)",
    ]);
  });
});

describe("models auth order", () => {
  const order = ["anthropic:b", "anthropic:a"];
  let runtime: ReturnType<typeof createRuntimeEnv>;
  function store(ids: string[], savedOrder?: string[], provider = "anthropic"): AuthProfileStore {
    return {
      ...createAuthProfileStoreFixture(
        Object.fromEntries(
          ids.map((id) => [
            id,
            createOAuthRefreshCredential({ provider: id.split(":")[0], access: "tok" }),
          ]),
        ),
      ),
      ...(savedOrder ? { order: { [provider]: savedOrder } } : {}),
    };
  }
  function expectWrite(agent: string, provider: string, ids: string[] | null) {
    expect(mocks.setAuthProfileOrder).toHaveBeenCalledWith({
      agentDir: `/tmp/openclaw/agents/${agent}`,
      provider,
      order: ids,
    });
  }
  beforeEach(() => {
    vi.clearAllMocks();
    runtime = createRuntimeEnv();
    mocks.loadModelsConfig.mockResolvedValue({});
    mocks.ensureAuthProfileStore.mockReturnValue(store(order.toReversed(), ["anthropic:a"]));
    mocks.setAuthProfileOrder.mockResolvedValue(store(order, order));
  });

  it("get resolves an omitted agent through the read target", async () => {
    await modelsAuthOrderGetCommand({ provider: "anthropic" }, runtime);
    expect(mocks.resolveModelsTargetAgent).toHaveBeenCalledWith(expect.anything(), undefined, {
      kind: "read",
    });
    expect(runtime.log).toHaveBeenCalledWith("Agent: main");
  });

  it.each([
    { agent: "ops", order, message: "Auth profile order override: anthropic:b, anthropic:a" },
    {
      agent: undefined,
      order: null,
      message: expect.stringContaining("Auth profile order override cleared"),
    },
  ])(
    "writes order $order for $agent and refreshes the gateway",
    async ({ agent, order: ids, message }) => {
      await modelsAuthOrderUpdateCommand({ provider: "anthropic", agent, order: ids }, runtime);
      expectWrite(agent ?? "main", "anthropic", ids);
      expect(mocks.resolveModelsTargetAgent).toHaveBeenCalledWith(expect.anything(), agent, {
        kind: "mutation",
      });
      expect(mocks.refreshRunningGatewayAuthState).toHaveBeenCalledWith(
        agent ?? "main",
        "update",
        runtime,
      );
      expect(runtime.log).toHaveBeenCalledWith(message);
    },
  );

  it("accepts alias-provider profiles and reports the canonical stored order", async () => {
    mocks.ensureAuthProfileStore.mockReturnValue(store(["xai:a"]));
    mocks.setAuthProfileOrder.mockResolvedValue(store([], ["xai:a"], "xai"));
    await modelsAuthOrderUpdateCommand({ provider: "x-ai", order: ["xai:a"] }, runtime);
    expectWrite("main", "xai", ["xai:a"]);
    expect(runtime.log).toHaveBeenCalledWith("Auth profile order override: xai:a");
  });

  it("does not refresh the gateway when the store update fails", async () => {
    mocks.setAuthProfileOrder.mockResolvedValue(null);
    await expect(
      modelsAuthOrderUpdateCommand({ provider: "anthropic", order: ["anthropic:a"] }, runtime),
    ).rejects.toThrow("Failed to update auth state");
    expect(mocks.refreshRunningGatewayAuthState).not.toHaveBeenCalled();
  });
});
