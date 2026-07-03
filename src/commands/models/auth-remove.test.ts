import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OutputRuntimeEnv } from "../../runtime.js";
import { modelsAuthRemoveCommand } from "./auth-remove.js";

const mocks = vi.hoisted(() => ({
  loadAuthProfileStoreWithoutExternalProfiles: vi.fn(),
  loadModelsConfig: vi.fn(),
  removeAuthProfilesWithLock: vi.fn(),
  resolveAuthProfileDisplayLabel: vi.fn(({ profileId }: { profileId: string }) => profileId),
  resolvePersistedAuthProfileOwnerAgentDir: vi.fn(
    ({ agentDir }: { agentDir: string; profileId: string }) => agentDir,
  ),
  resolveModelsTargetAgent: vi.fn((_cfg: OpenClawConfig, rawAgentId?: string) => {
    const agentId = rawAgentId ?? "main";
    return { agentDir: `/tmp/openclaw/agents/${agentId}`, agentId };
  }),
}));

vi.mock("../../agents/auth-profiles.js", () => ({
  loadAuthProfileStoreWithoutExternalProfiles: mocks.loadAuthProfileStoreWithoutExternalProfiles,
  removeAuthProfilesWithLock: mocks.removeAuthProfilesWithLock,
  resolveAuthProfileDisplayLabel: mocks.resolveAuthProfileDisplayLabel,
  resolvePersistedAuthProfileOwnerAgentDir: mocks.resolvePersistedAuthProfileOwnerAgentDir,
  resolveAuthStatePathForDisplay: (agentDir: string) => `${agentDir}/openclaw-agent.sqlite`,
}));

vi.mock("./load-config.js", () => ({
  loadModelsConfig: mocks.loadModelsConfig,
}));

vi.mock("./shared.js", () => ({
  resolveModelsTargetAgent: mocks.resolveModelsTargetAgent,
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

function createStore(): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "openai:user@example.com": {
        type: "oauth",
        provider: "openai",
        access: "access-secret",
        refresh: "refresh-secret",
        expires: 1_800_000_000_000,
        email: "user@example.com",
      },
      "openai:backup": {
        type: "api_key",
        provider: "openai",
        key: "sk-secret",
      },
      "anthropic:manual": {
        type: "token",
        provider: "anthropic",
        token: "token-secret",
      },
    },
  };
}

describe("modelsAuthRemoveCommand", () => {
  beforeEach(() => {
    mocks.loadModelsConfig.mockReset().mockResolvedValue({} as OpenClawConfig);
    mocks.loadAuthProfileStoreWithoutExternalProfiles.mockReset().mockReturnValue(createStore());
    mocks.removeAuthProfilesWithLock.mockReset().mockResolvedValue({ version: 1, profiles: {} });
    mocks.resolveAuthProfileDisplayLabel.mockClear();
    mocks.resolvePersistedAuthProfileOwnerAgentDir
      .mockReset()
      .mockImplementation(({ agentDir }: { agentDir: string; profileId: string }) => agentDir);
    mocks.resolveModelsTargetAgent.mockClear();
  });

  it("removes one explicit profile without printing secret material", async () => {
    const runtime = createRuntime();

    await modelsAuthRemoveCommand(
      { profileId: "openai:user@example.com", agent: "coder", yes: true, json: true },
      runtime,
    );

    expect(mocks.loadAuthProfileStoreWithoutExternalProfiles).toHaveBeenCalledWith(
      "/tmp/openclaw/agents/coder",
    );
    expect(mocks.removeAuthProfilesWithLock).toHaveBeenCalledWith({
      agentDir: "/tmp/openclaw/agents/coder",
      profileIds: ["openai:user@example.com"],
    });
    expect(runtime.jsonPayloads).toStrictEqual([
      {
        agentDir: "/tmp/openclaw/agents/coder",
        agentId: "coder",
        authStatePath: "/tmp/openclaw/agents/coder/openclaw-agent.sqlite",
        dryRun: false,
        removed: [
          {
            id: "openai:user@example.com",
            label: "openai:user@example.com",
            provider: "openai",
            type: "oauth",
          },
        ],
        wouldRemove: [],
      },
    ]);
    expect(JSON.stringify(runtime.jsonPayloads[0])).not.toContain("secret");
  });

  it("previews provider-wide removal without writing", async () => {
    const runtime = createRuntime();

    await modelsAuthRemoveCommand(
      { provider: "openai", all: true, dryRun: true, json: true },
      runtime,
    );

    expect(mocks.removeAuthProfilesWithLock).not.toHaveBeenCalled();
    expect(runtime.jsonPayloads).toStrictEqual([
      {
        agentDir: "/tmp/openclaw/agents/main",
        agentId: "main",
        authStatePath: "/tmp/openclaw/agents/main/openclaw-agent.sqlite",
        dryRun: true,
        removed: [],
        wouldRemove: [
          {
            id: "openai:backup",
            label: "openai:backup",
            provider: "openai",
            type: "api_key",
          },
          {
            id: "openai:user@example.com",
            label: "openai:user@example.com",
            provider: "openai",
            type: "oauth",
          },
        ],
      },
    ]);
  });

  it("requires --all for provider-wide removal", async () => {
    const runtime = createRuntime();

    await expect(
      modelsAuthRemoveCommand({ provider: "openai", yes: true }, runtime),
    ).rejects.toThrow("without --all");

    expect(mocks.removeAuthProfilesWithLock).not.toHaveBeenCalled();
  });

  it("rejects profiles inherited from the default agent store", async () => {
    const runtime = createRuntime();
    mocks.resolvePersistedAuthProfileOwnerAgentDir.mockImplementation(() => undefined);

    await expect(
      modelsAuthRemoveCommand(
        { profileId: "openai:user@example.com", agent: "coder", yes: true },
        runtime,
      ),
    ).rejects.toThrow("is inherited from main");

    expect(mocks.removeAuthProfilesWithLock).not.toHaveBeenCalled();
  });

  it("requires --yes when not attached to an interactive terminal", async () => {
    const runtime = createRuntime();

    await expect(
      modelsAuthRemoveCommand({ profileId: "openai:user@example.com" }, runtime),
    ).rejects.toThrow("requires --yes");

    expect(mocks.removeAuthProfilesWithLock).not.toHaveBeenCalled();
  });
});
