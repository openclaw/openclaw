// Model auth-list tests cover provider auth listing and output formatting.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "../../agents/auth-profiles/credential-fixtures.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import type { OutputRuntimeEnv } from "../../runtime.js";
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

function createRuntime(): OutputRuntimeEnv & { logs: string[]; jsonPayloads: unknown[] } {
  const logs: string[] = [];
  const jsonPayloads: unknown[] = [];
  return {
    logs,
    jsonPayloads,
    log: (...args: unknown[]) => {
      logs.push(args.map((value) => String(value)).join(" "));
    },
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit ${code}`);
    }),
    writeStdout: vi.fn(),
    writeJson: (value: unknown) => {
      jsonPayloads.push(value);
    },
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
    mocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "anthropic:claude-cli": {
          type: "oauth",
          provider: "claude-cli",
          access: "secret",
          refresh: "secret",
          expires: 1_900_000_000_000,
        },
      },
      usageStats: {
        "anthropic:claude-cli": {
          cooldownUntil: 1_900_000_100_000,
          cooldownReason: "session_expired",
        },
      },
    } satisfies AuthProfileStore);

    const textRuntime = createRuntime();
    await modelsAuthListCommand({}, textRuntime);
    expect(textRuntime.logs.at(-1)).toContain("cooldown:session_expired");
    expect(textRuntime.logs.at(-1)).toContain(
      "claude auth login && openclaw models auth login --provider anthropic --method cli",
    );

    const jsonRuntime = createRuntime();
    await modelsAuthListCommand({ json: true }, jsonRuntime);
    expect(jsonRuntime.jsonPayloads[0]).toMatchObject({
      profiles: [
        expect.objectContaining({
          id: "anthropic:claude-cli",
          cooldownReason: "session_expired",
          recoveryHint:
            "Re-authenticate with `claude auth login && openclaw models auth login --provider anthropic --method cli --profile-id 'anthropic:claude-cli'`.",
        }),
      ],
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
    mocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "openai:expired": {
          type: "oauth",
          provider: "openai",
          access: "secret",
          refresh: "secret",
          expires: 1_900_000_000_000,
        },
      },
      usageStats: {
        "openai:expired": {
          cooldownUntil: 1_900_000_100_000,
          cooldownReason: "auth",
          cooldownClassification: "wham_token_expired",
        },
      },
    } satisfies AuthProfileStore);

    const textRuntime = createRuntime();
    await modelsAuthListCommand({}, textRuntime);
    expect(textRuntime.logs.at(-1)).toContain("cooldown:wham_token_expired");

    const jsonRuntime = createRuntime();
    await modelsAuthListCommand({ json: true }, jsonRuntime);
    expect(jsonRuntime.jsonPayloads[0]).toMatchObject({
      profiles: [
        expect.objectContaining({
          cooldownReason: "auth",
          cooldownClassification: "wham_token_expired",
        }),
      ],
    });
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
        "openai:profile-wide": {
          blockedUntil: NOW + 60_000,
          blockedReason: "subscription_limit",
          blockedSource: "codex_rate_limits",
          blockedModel: "legacy-model-must-not-leak",
        },
        "openai:model-scoped": {
          blockedUntil: NOW + 120_000,
          blockedReason: "subscription_limit",
          blockedSource: "wham",
          blockedScope: "model",
          blockedModel: "gpt-5.5",
        },
        "openai:model-scope-without-model": {
          blockedUntil: NOW + 180_000,
          blockedReason: "subscription_limit",
          blockedSource: "wham",
          blockedScope: "model",
        },
        "openai:expired": {
          blockedUntil: NOW - 1,
          blockedReason: "subscription_limit",
          blockedSource: "codex_rate_limits",
          blockedScope: "model",
          blockedModel: "gpt-expired",
        },
        "openai:invalid": {
          blockedUntil: 8_700_000_000_000_000,
          blockedReason: "subscription_limit",
          blockedSource: "wham",
          blockedScope: "model",
          blockedModel: "gpt-invalid",
        },
      },
    } satisfies AuthProfileStore);

    const textRuntime = createRuntime();
    await modelsAuthListCommand({}, textRuntime);
    expect(textRuntime.logs.find((line) => line.includes("openai:profile-wide"))).toContain(
      "blocked:subscription_limit via codex_rate_limits for profile until 2026-08-30T00:01:00.000Z",
    );
    expect(textRuntime.logs.find((line) => line.includes("openai:model-scoped"))).toContain(
      "blocked:subscription_limit via wham for model gpt-5.5 until 2026-08-30T00:02:00.000Z",
    );
    expect(
      textRuntime.logs.find((line) => line.includes("openai:model-scope-without-model")),
    ).toContain("blocked:subscription_limit via wham for profile until 2026-08-30T00:03:00.000Z");
    for (const id of ["openai:expired", "openai:invalid"]) {
      expect(textRuntime.logs.find((line) => line.includes(id))).not.toContain("blocked:");
    }

    const jsonRuntime = createRuntime();
    await modelsAuthListCommand({ json: true }, jsonRuntime);
    const profiles = (
      jsonRuntime.jsonPayloads[0] as {
        profiles: Array<Record<string, unknown> & { id: string }>;
      }
    ).profiles;
    const byId = Object.fromEntries(profiles.map((entry) => [entry.id, entry]));
    expect(byId["openai:model-scoped"]).toMatchObject({
      blockedUntil: "2026-08-30T00:02:00.000Z",
      blockedReason: "subscription_limit",
      blockedSource: "wham",
      blockedScope: "model",
      blockedModel: "gpt-5.5",
    });
    expect(byId["openai:profile-wide"]).toMatchObject({
      blockedUntil: "2026-08-30T00:01:00.000Z",
      blockedReason: "subscription_limit",
      blockedSource: "codex_rate_limits",
      blockedScope: "profile",
    });
    expect(byId["openai:profile-wide"]).not.toHaveProperty("blockedModel");
    expect(byId["openai:model-scope-without-model"]).toMatchObject({
      blockedUntil: "2026-08-30T00:03:00.000Z",
      blockedReason: "subscription_limit",
      blockedSource: "wham",
      blockedScope: "profile",
    });
    expect(byId["openai:model-scope-without-model"]).not.toHaveProperty("blockedModel");
    for (const id of ["openai:expired", "openai:invalid"]) {
      const profileEntry = byId[id];
      expect(profileEntry).toBeDefined();
      expect(profileEntry).not.toHaveProperty("blockedUntil");
      expect(profileEntry).not.toHaveProperty("blockedReason");
      expect(profileEntry).not.toHaveProperty("blockedSource");
      expect(profileEntry).not.toHaveProperty("blockedScope");
      expect(profileEntry).not.toHaveProperty("blockedModel");
    }
    expect(JSON.stringify(jsonRuntime.jsonPayloads[0])).not.toMatch(
      /secret|legacy-model-must-not-leak/u,
    );
  });

  it("routes legacy Gemini CLI cooldowns to supported Google API-key setup", async () => {
    mocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "google-gemini-cli:legacy": {
          type: "oauth",
          provider: "google-gemini-cli",
          access: "secret",
          refresh: "secret",
          expires: 1_900_000_000_000,
        },
      },
      usageStats: {
        "google-gemini-cli:legacy": {
          cooldownUntil: 1_900_000_100_000,
          cooldownReason: "session_expired",
        },
      },
    } satisfies AuthProfileStore);

    const runtime = createRuntime();
    await modelsAuthListCommand({ json: true }, runtime);

    expect(runtime.jsonPayloads[0]).toMatchObject({
      profiles: [
        expect.objectContaining({
          id: "google-gemini-cli:legacy",
          recoveryHint: expect.stringContaining("--provider google`"),
        }),
      ],
    });
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
