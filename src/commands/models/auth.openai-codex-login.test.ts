import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  resolveDefaultAgentId: vi.fn(() => "main"),
  resolveAgentDir: vi.fn(() => "/tmp/openclaw-agent"),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/openclaw-workspace"),
  resolveDefaultAgentWorkspaceDir: vi.fn(() => "/tmp/openclaw-workspace"),
  loadValidConfigOrThrow: vi.fn(async () => ({}) as OpenClawConfig),
  updateConfig: vi.fn(),
  logConfigUpdated: vi.fn(),
  resolvePluginProviders: vi.fn(() => []),
  loginOpenAICodexOAuth: vi.fn(async () => ({
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60_000,
    email: "user@example.com",
  })),
  writeOAuthCredentials: vi.fn(async () => "openai-codex:user@example.com"),
  applyAuthProfileConfig: vi.fn((cfg: OpenClawConfig) => cfg),
  applyOpenAICodexModelDefault: vi.fn((cfg: OpenClawConfig) => ({
    next: cfg,
    changed: false,
  })),
  createClackPrompter: vi.fn(() => ({
    note: vi.fn(async () => {}),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    select: vi.fn(async () => ""),
  })),
}));

vi.mock("../../agents/agent-scope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/agent-scope.js")>();
  return {
    ...actual,
    resolveDefaultAgentId: mocks.resolveDefaultAgentId,
    resolveAgentDir: mocks.resolveAgentDir,
    resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  };
});

vi.mock("../../agents/workspace.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/workspace.js")>();
  return {
    ...actual,
    resolveDefaultAgentWorkspaceDir: mocks.resolveDefaultAgentWorkspaceDir,
  };
});

vi.mock("./shared.js", () => ({
  loadValidConfigOrThrow: mocks.loadValidConfigOrThrow,
  updateConfig: mocks.updateConfig,
}));

vi.mock("../../config/logging.js", () => ({
  logConfigUpdated: mocks.logConfigUpdated,
}));

vi.mock("../../plugins/providers.js", () => ({
  resolvePluginProviders: mocks.resolvePluginProviders,
}));

vi.mock("../openai-codex-oauth.js", () => ({
  loginOpenAICodexOAuth: mocks.loginOpenAICodexOAuth,
}));

vi.mock("../onboard-auth.js", () => ({
  applyAuthProfileConfig: mocks.applyAuthProfileConfig,
  writeOAuthCredentials: mocks.writeOAuthCredentials,
}));

vi.mock("../openai-codex-model-default.js", () => ({
  OPENAI_CODEX_DEFAULT_MODEL: "openai-codex/gpt-5.3-codex",
  applyOpenAICodexModelDefault: mocks.applyOpenAICodexModelDefault,
}));

vi.mock("../../wizard/clack-prompter.js", () => ({
  createClackPrompter: mocks.createClackPrompter,
}));

import { modelsAuthLoginCommand } from "./auth.js";

describe("modelsAuthLoginCommand openai-codex fallback", () => {
  let originalIsTTY = false;

  beforeEach(() => {
    originalIsTTY = Boolean(process.stdin.isTTY);
    (process.stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY = true;
    vi.clearAllMocks();
    mocks.updateConfig.mockImplementation(
      async (mutator: (cfg: OpenClawConfig) => OpenClawConfig) => mutator({} as OpenClawConfig),
    );
  });

  afterEach(() => {
    (process.stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY = originalIsTTY;
  });

  it("runs built-in codex oauth flow without requiring provider plugins", async () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await modelsAuthLoginCommand(
      {
        provider: "openai-codex",
        setDefault: false,
      },
      runtime,
    );

    expect(mocks.loginOpenAICodexOAuth).toHaveBeenCalledOnce();
    expect(mocks.writeOAuthCredentials).toHaveBeenCalledWith(
      "openai-codex",
      expect.objectContaining({ email: "user@example.com" }),
      "/tmp/openclaw-agent",
      { syncSiblingAgents: true },
    );
    expect(mocks.resolvePluginProviders).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      "Default model available: openai-codex/gpt-5.3-codex (use --set-default to apply)",
    );
  });

  it("applies codex default model when --set-default is true", async () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await modelsAuthLoginCommand(
      {
        provider: "openai-codex",
        setDefault: true,
      },
      runtime,
    );

    expect(mocks.applyOpenAICodexModelDefault).toHaveBeenCalledOnce();
    expect(runtime.log).toHaveBeenCalledWith("Default model set to openai-codex/gpt-5.3-codex");
  });
});
