import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OutputRuntimeEnv } from "../../runtime.js";
import { modelsAuthListCommand } from "./auth-list.js";

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  externalCliDiscoveryForProviderAuth: vi.fn(() => ({ kind: "none" })),
  loadModelsConfig: vi.fn(),
  resolveAuthProfileDisplayLabel: vi.fn(({ profileId }: { profileId: string }) => profileId),
  resolveKnownAgentId: vi.fn(({ rawAgentId }: { rawAgentId?: string }) => rawAgentId ?? undefined),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentDir: (_cfg: OpenClawConfig, agentId: string) => `/tmp/openclaw/agents/${agentId}`,
  resolveDefaultAgentId: () => "main",
}));

vi.mock("../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: mocks.ensureAuthProfileStore,
  externalCliDiscoveryForProviderAuth: mocks.externalCliDiscoveryForProviderAuth,
  resolveAuthProfileDisplayLabel: mocks.resolveAuthProfileDisplayLabel,
  resolveAuthStatePathForDisplay: (agentDir: string) => `${agentDir}/auth-state.json`,
}));

vi.mock("./load-config.js", () => ({
  loadModelsConfig: mocks.loadModelsConfig,
}));

vi.mock("./shared.js", () => ({
  resolveKnownAgentId: mocks.resolveKnownAgentId,
}));

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
    mocks.resolveKnownAgentId.mockClear();
  });

  it("filters profiles by provider and redacts credential material in JSON output", async () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai-codex:user@example.com": {
          type: "oauth",
          provider: "openai-codex",
          access: "access-secret",
          refresh: "refresh-secret",
          expires: 1_800_000_000_000,
          email: "user@example.com",
        },
        "anthropic:manual": {
          type: "token",
          provider: "anthropic",
          token: "token-secret",
        },
      },
      usageStats: {
        "openai-codex:user@example.com": {
          cooldownUntil: 1_800_000_010_000,
        },
      },
    };
    mocks.ensureAuthProfileStore.mockReturnValue(store);
    const runtime = createRuntime();

    await modelsAuthListCommand({ provider: "OpenAI-Codex", agent: "coder", json: true }, runtime);

    expect(mocks.externalCliDiscoveryForProviderAuth).toHaveBeenCalledWith({
      cfg: {},
      provider: "openai-codex",
    });
    expect(runtime.jsonPayloads).toHaveLength(1);
    expect(JSON.stringify(runtime.jsonPayloads[0])).not.toContain("secret");
    expect(runtime.jsonPayloads[0]).toMatchObject({
      agentId: "coder",
      provider: "openai-codex",
      profiles: [
        {
          id: "openai-codex:user@example.com",
          provider: "openai-codex",
          type: "oauth",
          email: "user@example.com",
          expiresAt: "2027-01-15T08:00:00.000Z",
          cooldownUntil: "2027-01-15T08:00:10.000Z",
        },
      ],
    });
  });

  it("includes claude-cli profile when filtering by --provider anthropic", async () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "anthropic:claude-cli": {
          type: "oauth",
          provider: "claude-cli",
          access: "access-secret",
          refresh: "refresh-secret",
          expires: 1_800_000_000_000,
          email: "user@example.com",
        },
        "openai:api-key": {
          type: "api_key",
          provider: "openai",
          key: "sk-secret",
        },
      },
    };
    mocks.ensureAuthProfileStore.mockReturnValue(store);
    const runtime = createRuntime();

    await modelsAuthListCommand({ provider: "anthropic", json: true }, runtime);

    expect(runtime.jsonPayloads).toHaveLength(1);
    const payload = runtime.jsonPayloads[0] as { profiles: { id: string; provider: string }[] };
    expect(payload.profiles).toHaveLength(1);
    expect(payload.profiles[0]).toMatchObject({
      id: "anthropic:claude-cli",
      provider: "claude-cli",
    });
  });

  it("prints an empty profile list without failing", async () => {
    mocks.ensureAuthProfileStore.mockReturnValue({ version: 1, profiles: {} });
    const runtime = createRuntime();

    await modelsAuthListCommand({}, runtime);

    expect(runtime.logs).toEqual([
      "Agent: main",
      "Auth state file: /tmp/openclaw/agents/main/auth-state.json",
      "Profiles: (none)",
    ]);
  });
});
