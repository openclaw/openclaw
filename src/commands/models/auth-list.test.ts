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
import { listUnavailableAuthProfiles } from "./auth-unavailability.js";

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
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

vi.mock("../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: mocks.ensureAuthProfileStore,
  externalCliDiscoveryForProviderAuth: mocks.externalCliDiscoveryForProviderAuth,
  resolveAuthProfileDisplayLabel: mocks.resolveAuthProfileDisplayLabel,
  resolveAuthStatePathForDisplay: mocks.resolveAuthStatePathForDisplay,
}));

vi.mock("./load-config.js", () => ({
  loadModelsConfig: mocks.loadModelsConfig,
}));

vi.mock("./shared.js", () => ({
  resolveModelsTargetAgent: mocks.resolveModelsTargetAgent,
}));

const NOW = Date.parse("2026-08-30T00:00:00.000Z");

function createRuntime() {
  const logs: string[] = [];
  const jsonPayloads: unknown[] = [];
  return {
    ...createRuntimeEnv(),
    logs,
    jsonPayloads,
    log: (...args: unknown[]) => {
      logs.push(args.map((value) => String(value)).join(" "));
    },
    writeJson: (value: unknown) => {
      jsonPayloads.push(value);
    },
  };
}

async function list(options: Parameters<typeof modelsAuthListCommand>[0] = {}) {
  const runtime = createRuntime();
  await modelsAuthListCommand(options, runtime);
  return runtime;
}

async function listBoth() {
  return { text: (await list()).logs, json: (await list({ json: true })).jsonPayloads[0] };
}

function expectProfiles(json: unknown, profiles: unknown[]) {
  expect(json).toMatchObject({ profiles });
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

function subscriptionBlock(
  blockedUntil: number,
  blockedSource: "wham" | "codex_rate_limits",
  overrides: Partial<NonNullable<AuthProfileStore["usageStats"]>[string]> = {},
) {
  return {
    blockedUntil,
    blockedReason: "subscription_limit" as const,
    blockedSource,
    ...overrides,
  };
}

describe("modelsAuthListCommand", () => {
  beforeEach(() => {
    mocks.loadModelsConfig.mockReset().mockResolvedValue({} as OpenClawConfig);
    mocks.ensureAuthProfileStore.mockReset();
    mocks.externalCliDiscoveryForProviderAuth.mockClear();
    mocks.resolveAuthProfileDisplayLabel.mockClear();
    mocks.resolveAuthStatePathForDisplay
      .mockReset()
      .mockImplementation((agentDir: string) => `${agentDir}/openclaw-agent.sqlite`);
    mocks.resolveModelsTargetAgent.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the cooldown reason and re-authentication action in text and JSON", async () => {
    setOAuthProfile("anthropic:claude-cli", "claude-cli", {
      cooldownUntil: 1_900_000_100_000,
      cooldownReason: "session_expired",
    });
    const { text, json } = await listBoth();
    expect(text.at(-1)).toContain("cooldown:session_expired");
    expect(text.at(-1)).toContain(
      "claude auth login && openclaw models auth login --provider anthropic --method cli",
    );

    expectProfiles(json, [
      expect.objectContaining({
        id: "anthropic:claude-cli",
        cooldownReason: "session_expired",
        recoveryHint:
          "Re-authenticate with `claude auth login && openclaw models auth login --provider anthropic --method cli --profile-id 'anthropic:claude-cli'`.",
      }),
    ]);
  });

  it.each(["rate_limit", "overloaded", "auth", "auth_permanent", "billing"] as const)(
    "shows only enforced %s health for a self-managed provider",
    async (reason) => {
      const snapshot = createPluginMetadataSnapshotFixture({
        plugins: [{ id: "gateway", providers: ["my-gateway"], managesOwnAvailability: true }],
      });
      const disabled = reason === "auth_permanent" || reason === "billing";
      const bypassed = reason === "rate_limit" || reason === "overloaded";
      const window = disabled
        ? {
            cooldownUntil: 1_900_003_100_000,
            cooldownReason: "rate_limit" as const,
            disabledUntil: 1_900_000_100_000,
            disabledReason: reason,
          }
        : { cooldownUntil: 1_900_000_100_000, cooldownReason: reason };
      mocks.ensureAuthProfileStore.mockReturnValue({
        version: 1,
        profiles: { "my-gateway:manual": createApiKeyCredential("my-gateway", "synthetic-key") },
        usageStats: { "my-gateway:manual": window },
      } satisfies AuthProfileStore);
      const jsonRuntime = createRuntime();
      const textRuntime = createRuntime();
      await withPluginMetadataSnapshotScope(
        snapshot,
        async () => {
          await modelsAuthListCommand({ json: true }, jsonRuntime);
          await modelsAuthListCommand({}, textRuntime);
          if (disabled) {
            expect(listUnavailableAuthProfiles(mocks.ensureAuthProfileStore())).toEqual([
              expect.objectContaining({
                profileId: "my-gateway:manual",
                kind: "disabled",
                reason,
                until: 1_900_000_100_000,
              }),
            ]);
          }
        },
        { trustConfigIdentity: true },
      );
      const identity = {
        id: "my-gateway:manual",
        label: "my-gateway:manual",
        provider: "my-gateway",
        type: "api_key",
      };
      if (bypassed) {
        expect(jsonRuntime.jsonPayloads[0]).toMatchObject({ profiles: [identity] });
        expect(jsonRuntime.jsonPayloads[0]).not.toMatchObject({
          profiles: [expect.objectContaining({ cooldownUntil: expect.anything() })],
        });
        expect(textRuntime.logs.at(-1)).toBe("- my-gateway:manual [my-gateway/api_key]");
      } else {
        expect(jsonRuntime.jsonPayloads[0]).toMatchObject({
          profiles: [{ ...identity, [disabled ? "disabledReason" : "cooldownReason"]: reason }],
        });
        expect(textRuntime.logs.at(-1)).toContain((disabled ? "disabled:" : "cooldown:") + reason);
        if (disabled) {
          expect(jsonRuntime.jsonPayloads[0]).not.toMatchObject({
            profiles: [expect.objectContaining({ cooldownUntil: expect.anything() })],
          });
          expect(textRuntime.logs.at(-1)).not.toContain("cooldown");
        }
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
    expectProfiles(json, [
      expect.objectContaining({
        cooldownReason: "auth",
        cooldownClassification: "wham_token_expired",
      }),
    ]);
  });

  it("projects only active subscription blocks in text and JSON", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const profile = { type: "api_key", provider: "openai", key: "credential-secret" } as const;
    mocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "openai:profile-wide": profile,
        "openai:model-scoped": profile,
        "openai:model-scope-without-model": profile,
        "openai:expired": profile,
        "openai:invalid": profile,
      },
      usageStats: {
        "openai:profile-wide": subscriptionBlock(NOW + 60_000, "codex_rate_limits", {
          blockedModel: "legacy-model-must-not-leak",
        }),
        "openai:model-scoped": subscriptionBlock(NOW + 120_000, "wham", {
          blockedScope: "model",
          blockedModel: "gpt-5.5",
        }),
        "openai:model-scope-without-model": subscriptionBlock(NOW + 180_000, "wham", {
          blockedScope: "model",
        }),
        "openai:expired": subscriptionBlock(NOW - 1, "codex_rate_limits", {
          blockedScope: "model",
          blockedModel: "gpt-expired",
        }),
        "openai:invalid": subscriptionBlock(8_700_000_000_000_000, "wham", {
          blockedScope: "model",
          blockedModel: "gpt-invalid",
        }),
      },
    } satisfies AuthProfileStore);

    const { text, json } = await listBoth();
    const profiles = (
      json as {
        profiles: Array<Record<string, unknown> & { id: string }>;
      }
    ).profiles;
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
      const profileEntry = byId[id];
      expect(profileEntry).toBeDefined();
      for (const field of [
        "blockedUntil",
        "blockedReason",
        "blockedSource",
        "blockedScope",
        "blockedModel",
      ]) {
        expect(profileEntry).not.toHaveProperty(field);
      }
    }
    expect(JSON.stringify(json)).not.toMatch(/secret|legacy-model-must-not-leak/u);
  });

  it("routes legacy Gemini CLI cooldowns to supported Google API-key setup", async () => {
    setOAuthProfile("google-gemini-cli:legacy", "google-gemini-cli", {
      cooldownUntil: 1_900_000_100_000,
      cooldownReason: "session_expired",
    });
    const runtime = await list({ json: true });

    expectProfiles(runtime.jsonPayloads[0], [
      expect.objectContaining({
        id: "google-gemini-cli:legacy",
        recoveryHint: expect.stringContaining("--provider google`"),
      }),
    ]);
    expect(JSON.stringify(runtime.jsonPayloads[0])).not.toContain("--provider google-gemini-cli");
  });

  it("treats the OpenAI filter as the friendly view over API-key and OAuth profiles", async () => {
    const store: AuthProfileStore = createAuthProfileStoreFixture({
      "openai:user@example.com": {
        type: "oauth",
        provider: "openai",
        access: "access-secret",
        refresh: "refresh-secret",
        expires: 1_800_000_000_000,
        email: "user@example.com",
      },
      "openai:api-key-backup": createApiKeyCredential("openai", "sk-secret"),
      "anthropic:manual": {
        type: "token",
        provider: "anthropic",
        token: "token-secret",
      },
    });
    mocks.ensureAuthProfileStore.mockReturnValue(store);
    const runtime = createRuntime();

    await modelsAuthListCommand({ provider: "OpenAI", json: true }, runtime);

    expect(mocks.externalCliDiscoveryForProviderAuth).toHaveBeenCalledWith({
      cfg: {},
      provider: "openai",
    });
    expect(runtime.jsonPayloads).toStrictEqual([
      {
        agentDir: "/tmp/openclaw/agents/main",
        agentId: "main",
        authStatePath: "/tmp/openclaw/agents/main/openclaw-agent.sqlite",
        profiles: [
          {
            id: "openai:api-key-backup",
            label: "openai:api-key-backup",
            provider: "openai",
            type: "api_key",
          },
          {
            email: "user@example.com",
            expiresAt: "2027-01-15T08:00:00.000Z",
            id: "openai:user@example.com",
            label: "openai:user@example.com",
            provider: "openai",
            type: "oauth",
          },
        ],
        provider: "openai",
      },
    ]);
    expect(JSON.stringify(runtime.jsonPayloads[0])).not.toContain("secret");
  });

  it("prints an empty profile list with the actual shared auth path", async () => {
    const authStatePath = "/tmp/openclaw/state/openclaw.sqlite";
    mocks.ensureAuthProfileStore.mockReturnValue({ version: 1, profiles: {} });
    mocks.resolveAuthStatePathForDisplay.mockReturnValue(authStatePath);
    const runtime = createRuntime();

    await modelsAuthListCommand({}, runtime);

    expect(runtime.logs).toEqual([
      "Agent: main",
      `Auth state store: ${authStatePath}`,
      "Profiles: (none)",
    ]);
  });

  it("omits Date-invalid auth timestamps without failing", async () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:user@example.com": {
          type: "oauth",
          provider: "openai",
          access: "access-secret",
          refresh: "refresh-secret",
          expires: 8_700_000_000_000_000,
          email: "user@example.com",
        },
      },
      usageStats: {
        "openai:user@example.com": {
          cooldownUntil: 8_700_000_000_000_000,
        },
      },
    };
    mocks.ensureAuthProfileStore.mockReturnValue(store);
    const runtime = createRuntime();

    await modelsAuthListCommand({ provider: "openai", json: true }, runtime);

    expect(runtime.jsonPayloads).toStrictEqual([
      {
        agentDir: "/tmp/openclaw/agents/main",
        agentId: "main",
        authStatePath: "/tmp/openclaw/agents/main/openclaw-agent.sqlite",
        profiles: [
          {
            email: "user@example.com",
            id: "openai:user@example.com",
            label: "openai:user@example.com",
            provider: "openai",
            type: "oauth",
          },
        ],
        provider: "openai",
      },
    ]);
  });
});
