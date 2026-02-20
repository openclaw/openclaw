import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime.js";

const mocks = vi.hoisted(() => {
  const state = {
    updatedConfig: undefined as unknown,
  };
  return {
    state,
    resolveDefaultAgentId: vi.fn(),
    resolveAgentDir: vi.fn(),
    resolveAgentWorkspaceDir: vi.fn(),
    resolveDefaultAgentWorkspaceDir: vi.fn(),
    resolvePluginProviders: vi.fn(),
    upsertAuthProfile: vi.fn(),
    loginAnthropicOAuth: vi.fn(),
    isRemoteEnvironment: vi.fn(),
    applyAuthProfileConfig: vi.fn(),
    applyDefaultModel: vi.fn(),
    mergeConfigPatch: vi.fn((cfg) => cfg),
    pickAuthMethod: vi.fn(),
    resolveProviderMatch: vi.fn(),
    loadValidConfigOrThrow: vi.fn(),
    updateConfig: vi.fn(),
    createClackPrompter: vi.fn(),
    logConfigUpdated: vi.fn(),
  };
});

vi.mock("../../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
  resolveAgentDir: mocks.resolveAgentDir,
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
}));

vi.mock("../../agents/workspace.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/workspace.js")>(
    "../../agents/workspace.js",
  );
  return {
    ...actual,
    resolveDefaultAgentWorkspaceDir: mocks.resolveDefaultAgentWorkspaceDir,
  };
});

vi.mock("../../plugins/providers.js", () => ({
  resolvePluginProviders: mocks.resolvePluginProviders,
}));

vi.mock("../../agents/auth-profiles.js", () => ({
  upsertAuthProfile: mocks.upsertAuthProfile,
}));

vi.mock("../../wizard/clack-prompter.js", () => ({
  createClackPrompter: mocks.createClackPrompter,
}));

vi.mock("../anthropic-oauth.js", () => ({
  loginAnthropicOAuth: mocks.loginAnthropicOAuth,
}));

vi.mock("../oauth-env.js", () => ({
  isRemoteEnvironment: mocks.isRemoteEnvironment,
}));

vi.mock("../onboard-auth.js", () => ({
  applyAuthProfileConfig: mocks.applyAuthProfileConfig,
}));

vi.mock("../provider-auth-helpers.js", () => ({
  applyDefaultModel: mocks.applyDefaultModel,
  mergeConfigPatch: mocks.mergeConfigPatch,
  pickAuthMethod: mocks.pickAuthMethod,
  resolveProviderMatch: mocks.resolveProviderMatch,
}));

vi.mock("../../config/logging.js", () => ({
  logConfigUpdated: mocks.logConfigUpdated,
}));

vi.mock("./shared.js", () => ({
  loadValidConfigOrThrow: mocks.loadValidConfigOrThrow,
  updateConfig: mocks.updateConfig,
}));

import { modelsAuthLoginCommand } from "./auth.js";

const ORIGINAL_IS_TTY = process.stdin.isTTY;

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

describe("modelsAuthLoginCommand anthropic oauth path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.updatedConfig = undefined;
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
      writable: true,
    });

    mocks.loadValidConfigOrThrow.mockResolvedValue({});
    mocks.resolveDefaultAgentId.mockReturnValue("james");
    mocks.resolveAgentDir.mockReturnValue("/tmp/openclaw/agents/james/agent");
    mocks.resolveAgentWorkspaceDir.mockReturnValue("/tmp/openclaw/workspace-james");
    mocks.resolveDefaultAgentWorkspaceDir.mockReturnValue("/tmp/openclaw/workspace");
    mocks.resolvePluginProviders.mockReturnValue([]);
    mocks.isRemoteEnvironment.mockReturnValue(false);
    mocks.createClackPrompter.mockReturnValue({});
    mocks.loginAnthropicOAuth.mockResolvedValue({
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
    });
    mocks.applyAuthProfileConfig.mockImplementation((cfg, params) => ({ ...cfg, auth: params }));
    mocks.applyDefaultModel.mockImplementation((cfg, model) => ({ ...cfg, model }));
    mocks.updateConfig.mockImplementation(async (updater: (cfg: unknown) => unknown) => {
      mocks.state.updatedConfig = updater({});
    });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: ORIGINAL_IS_TTY,
      configurable: true,
      writable: true,
    });
  });

  it("writes anthropic oauth creds to the resolved agent dir and applies --set-default", async () => {
    const runtime = createRuntime();

    await modelsAuthLoginCommand(
      {
        provider: "anthropic",
        method: "oauth",
        setDefault: true,
      },
      runtime,
    );

    expect(mocks.upsertAuthProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "anthropic:default",
        agentDir: "/tmp/openclaw/agents/james/agent",
      }),
    );
    expect(mocks.applyDefaultModel).toHaveBeenCalledWith(
      expect.any(Object),
      "anthropic/claude-sonnet-4-6",
    );
    expect(mocks.state.updatedConfig).toEqual(
      expect.objectContaining({
        model: "anthropic/claude-sonnet-4-6",
      }),
    );
  });

  it("does not apply a default model when --set-default is false", async () => {
    const runtime = createRuntime();

    await modelsAuthLoginCommand(
      {
        provider: "anthropic",
        method: "oauth",
        setDefault: false,
      },
      runtime,
    );

    expect(mocks.upsertAuthProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: "/tmp/openclaw/agents/james/agent",
      }),
    );
    expect(mocks.applyDefaultModel).not.toHaveBeenCalled();
  });
});
