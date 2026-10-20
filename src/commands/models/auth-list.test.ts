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

// mock-isolation: Listing formats synthetic profiles without reading host stores or external CLIs.
vi.mock("../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStoreAsync: async (...args: unknown[]) => mocks.ensureAuthProfileStore(...args),
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
  blockedModel?: string,
  blockedScope?: "model",
) {
  return {
    blockedUntil,
    blockedReason: "subscription_limit" as const,
    blockedSource,
    ...(blockedModel ? { blockedModel } : {}),
    ...(blockedScope ? { blockedScope } : {}),
  };
}

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

    expectProfile(json, {
      id: "anthropic:claude-cli",
      cooldownReason: "session_expired",
      recoveryHint:
        "Re-authenticate with `claude auth login && openclaw models auth login --provider anthropic --method cli --profile-id 'anthropic:claude-cli'`.",
    });
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
      const { text, json } = await withPluginMetadataSnapshotScope(
        snapshot,
        async () => {
          const output = await listBoth();
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
          return output;
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
        expect(json).toMatchObject({ profiles: [identity] });
        expect(text.at(-1)).toBe("- my-gateway:manual [my-gateway/api_key]");
      } else {
        expect(json).toMatchObject({
          profiles: [{ ...identity, [disabled ? "disabledReason" : "cooldownReason"]: reason }],
        });
        expect(text.at(-1)).toContain((disabled ? "disabled:" : "cooldown:") + reason);
        if (disabled) {
          expect(text.at(-1)).not.toContain("cooldown");
        }
      }
      if (bypassed || disabled) {
        expect(json).not.toMatchObject({
          profiles: [expect.objectContaining({ cooldownUntil: expect.anything() })],
        });
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
    expectProfile(json, {
      cooldownReason: "auth",
      cooldownClassification: "wham_token_expired",
    });
  });

  it("projects only active subscription blocks in text and JSON", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const profile = { type: "api_key", provider: "openai", key: "credential-secret" } as const;
    const usageStats = {
      "openai:profile-wide": subscriptionBlock(
        NOW + 60_000,
        "codex_rate_limits",
        "legacy-model-must-not-leak",
      ),
      "openai:model-scoped": subscriptionBlock(NOW + 120_000, "wham", "gpt-5.5", "model"),
      "openai:model-scope-without-model": subscriptionBlock(
        NOW + 180_000,
        "wham",
        undefined,
        "model",
      ),
      "openai:expired": subscriptionBlock(NOW - 1, "codex_rate_limits", "gpt-expired", "model"),
      "openai:invalid": subscriptionBlock(8_700_000_000_000_000, "wham", "gpt-invalid", "model"),
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

    expectProfile(runtime.jsonPayloads[0], {
      id: "google-gemini-cli:legacy",
      recoveryHint: expect.stringContaining("--provider google`"),
    });
    expect(JSON.stringify(runtime.jsonPayloads[0])).not.toContain("--provider google-gemini-cli");
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
        "anthropic:manual": {
          type: "token",
          provider: "anthropic",
          token: "token-secret",
        },
      });
      if (expires === 8_700_000_000_000_000) {
        store.usageStats = { "openai:user@example.com": { cooldownUntil: expires } };
      }
      mocks.ensureAuthProfileStore.mockReturnValue(store);
      const runtime = await list({ provider: "OpenAI", json: true });

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
              ...expectedExpiry,
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
