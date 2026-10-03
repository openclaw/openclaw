// Covers `models auth clear-cooldown`: target resolution, one owner-routed reset, and gateway refresh.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RuntimeEnv } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  clearAuthProfileCooldown: vi.fn(),
  loadModelsConfig: vi.fn(),
  resolveModelsTargetAgent: vi.fn((_cfg: OpenClawConfig, rawAgentId?: string) => ({
    agentId: rawAgentId ?? "main",
    agentDir: `/tmp/agent-${rawAgentId ?? "main"}`,
  })),
  refreshRunningGatewayAuthState: vi.fn(async () => "refreshed"),
}));

vi.mock("../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: mocks.ensureAuthProfileStore,
  clearAuthProfileCooldown: mocks.clearAuthProfileCooldown,
}));

vi.mock("./load-config.js", () => ({
  loadModelsConfig: mocks.loadModelsConfig,
}));

vi.mock("./shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared.js")>();
  return {
    ...actual,
    resolveModelsTargetAgent: mocks.resolveModelsTargetAgent,
  };
});

vi.mock("./auth-refresh.js", () => ({
  refreshRunningGatewayAuthState: mocks.refreshRunningGatewayAuthState,
}));

const { modelsAuthClearCooldownCommand } = await import("./auth-clear-cooldown.js");

const profileId = "anthropic:work";

function createRuntime(): RuntimeEnv & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    log: (message: string) => {
      logs.push(message);
    },
    error: () => {},
  } as unknown as RuntimeEnv & { logs: string[] };
}

function blockedStore(): AuthProfileStore {
  return {
    version: 1,
    profiles: { [profileId]: { type: "api_key", provider: "anthropic", key: "placeholder" } },
    usageStats: {
      [profileId]: { disabledUntil: Date.now() + 3_600_000, disabledReason: "billing" },
    },
  };
}

describe("models auth clear-cooldown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadModelsConfig.mockResolvedValue({} as OpenClawConfig);
    mocks.ensureAuthProfileStore.mockReturnValue(blockedStore());
    mocks.clearAuthProfileCooldown.mockResolvedValue(true);
  });

  it("resets the selected agent's profile once and refreshes the running gateway", async () => {
    const runtime = createRuntime();

    await modelsAuthClearCooldownCommand({ profileId: ` ${profileId} `, agent: "work" }, runtime);

    expect(mocks.resolveModelsTargetAgent).toHaveBeenCalledWith({}, "work", { kind: "mutation" });
    expect(mocks.clearAuthProfileCooldown).toHaveBeenCalledOnce();
    expect(mocks.clearAuthProfileCooldown).toHaveBeenCalledWith({
      store: mocks.ensureAuthProfileStore.mock.results[0]?.value,
      profileId,
      agentDir: "/tmp/agent-work",
    });
    expect(mocks.refreshRunningGatewayAuthState).toHaveBeenCalledWith("work", "update", runtime);
    expect(runtime.logs).toContain(`Cleared cooldown state for auth profile "${profileId}".`);
  });

  it.each(["anthropic:missing", "constructor"])(
    "rejects unknown profile id %s without writing",
    async (missingProfileId) => {
      await expect(
        modelsAuthClearCooldownCommand({ profileId: missingProfileId }, createRuntime()),
      ).rejects.toThrow(`Auth profile "${missingProfileId}" not found`);

      expect(mocks.clearAuthProfileCooldown).not.toHaveBeenCalled();
      expect(mocks.refreshRunningGatewayAuthState).not.toHaveBeenCalled();
    },
  );

  it("fails visibly on lock contention and keeps the target agent in the retry command", async () => {
    mocks.clearAuthProfileCooldown.mockResolvedValue(false);
    const runtime = createRuntime();

    await expect(
      modelsAuthClearCooldownCommand({ profileId, agent: "work" }, runtime),
    ).rejects.toThrow(`clear-cooldown ${profileId} --agent work`);

    expect(runtime.logs).toEqual([]);
    expect(mocks.refreshRunningGatewayAuthState).not.toHaveBeenCalled();
  });
});
