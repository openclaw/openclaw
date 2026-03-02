import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

const mocks = vi.hoisted(() => ({
  resolveDefaultAgentId: vi.fn(() => "default-agent"),
  resolveAgentDir: vi.fn(() => "/tmp/openclaw-agent"),
  resolveAgentWorkspaceDir: vi.fn(() => undefined),
  resolveDefaultAgentWorkspaceDir: vi.fn(() => "/tmp/openclaw-workspace"),
  resolvePluginProviders: vi.fn(() => []),
  createClackPrompter: vi.fn(() => ({
    select: vi.fn(),
    note: vi.fn(),
  })),
  loadValidConfigOrThrow: vi.fn(async () => ({})),
  updateConfig: vi.fn(async () => {}),
  isRemoteEnvironment: vi.fn(() => false),
  loginOpenAICodexOAuth: vi.fn<(params: unknown) => Promise<Record<string, unknown> | null>>(
    async () => null,
  ),
  writeOAuthCredentials: vi.fn(async () => "openai-codex:user@example.com"),
  logConfigUpdated: vi.fn(),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
  resolveAgentDir: mocks.resolveAgentDir,
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
}));

vi.mock("../agents/workspace.js", () => ({
  DEFAULT_AGENT_WORKSPACE_DIR: "/tmp/openclaw-workspace",
  resolveDefaultAgentWorkspaceDir: mocks.resolveDefaultAgentWorkspaceDir,
}));

vi.mock("../plugins/providers.js", () => ({
  resolvePluginProviders: mocks.resolvePluginProviders,
}));

vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: mocks.createClackPrompter,
}));

vi.mock("./models/shared.js", () => ({
  loadValidConfigOrThrow: mocks.loadValidConfigOrThrow,
  updateConfig: mocks.updateConfig,
}));

vi.mock("./oauth-env.js", () => ({
  isRemoteEnvironment: mocks.isRemoteEnvironment,
}));

vi.mock("./openai-codex-oauth.js", () => ({
  loginOpenAICodexOAuth: mocks.loginOpenAICodexOAuth,
}));

vi.mock("./onboard-auth.js", () => ({
  writeOAuthCredentials: mocks.writeOAuthCredentials,
  applyAuthProfileConfig: vi.fn((cfg) => cfg),
}));

vi.mock("../config/logging.js", () => ({
  logConfigUpdated: mocks.logConfigUpdated,
}));

describe("modelsAuthLoginCommand (openai-codex)", () => {
  let modelsAuthLoginCommand: typeof import("./models/auth.js").modelsAuthLoginCommand;
  let previousIsTTYDescriptor: PropertyDescriptor | undefined;
  const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };

  const runtime: RuntimeEnv = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };

  beforeAll(async () => {
    ({ modelsAuthLoginCommand } = await import("./models/auth.js"));
  });

  beforeEach(() => {
    previousIsTTYDescriptor = Object.getOwnPropertyDescriptor(stdin, "isTTY");
    Object.defineProperty(stdin, "isTTY", {
      configurable: true,
      enumerable: true,
      get: () => true,
    });

    mocks.resolvePluginProviders.mockReset();
    mocks.resolvePluginProviders.mockReturnValue([]);
    mocks.createClackPrompter.mockReset();
    mocks.createClackPrompter.mockReturnValue({ select: vi.fn(), note: vi.fn() });
    mocks.loadValidConfigOrThrow.mockReset();
    mocks.loadValidConfigOrThrow.mockResolvedValue({});
    mocks.updateConfig.mockReset();
    mocks.updateConfig.mockResolvedValue(undefined);
    mocks.loginOpenAICodexOAuth.mockReset();
    mocks.loginOpenAICodexOAuth.mockResolvedValue({
      email: "user@example.com",
      refresh: "refresh-token",
      access: "access-token",
      expires: Date.now() + 60_000,
    });
    mocks.writeOAuthCredentials.mockReset();
    mocks.writeOAuthCredentials.mockResolvedValue("openai-codex:user@example.com");
    mocks.logConfigUpdated.mockReset();
    (runtime.log as ReturnType<typeof vi.fn>).mockReset();
    (runtime.error as ReturnType<typeof vi.fn>).mockReset();
    (runtime.exit as ReturnType<typeof vi.fn>).mockReset();
  });

  afterEach(() => {
    if (previousIsTTYDescriptor) {
      Object.defineProperty(stdin, "isTTY", previousIsTTYDescriptor);
      return;
    }
    delete (stdin as { isTTY?: boolean }).isTTY;
  });

  it("succeeds with --provider openai-codex when plugin providers are empty", async () => {
    await expect(modelsAuthLoginCommand({ provider: "openai-codex" }, runtime)).resolves.toBe(
      undefined,
    );

    expect(mocks.resolvePluginProviders).toHaveBeenCalled();
    expect(mocks.loginOpenAICodexOAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime,
        isRemote: false,
      }),
    );
    expect(mocks.writeOAuthCredentials).toHaveBeenCalledWith(
      "openai-codex",
      expect.objectContaining({ email: "user@example.com" }),
      "/tmp/openclaw-agent",
      { syncSiblingAgents: true },
    );
  });

  it("offers and selects built-in OpenAI Codex in interactive provider selection", async () => {
    const select = vi.fn(async (params: { options: Array<{ value: string; label: string }> }) => {
      expect(params.options).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            value: "openai-codex",
            label: "OpenAI Codex",
          }),
        ]),
      );
      return "openai-codex";
    });

    mocks.createClackPrompter.mockReturnValue({ select, note: vi.fn() });

    await modelsAuthLoginCommand({}, runtime);

    expect(select).toHaveBeenCalledWith(expect.objectContaining({ message: "Select a provider" }));
    expect(mocks.loginOpenAICodexOAuth).toHaveBeenCalledTimes(1);
  });

  it("rejects non-oauth --method values for openai-codex", async () => {
    await expect(
      modelsAuthLoginCommand({ provider: "openai-codex", method: "device-code" }, runtime),
    ).rejects.toThrowError(
      'Unsupported auth method "device-code" for openai-codex. Use --method oauth or omit --method.',
    );

    expect(mocks.loginOpenAICodexOAuth).not.toHaveBeenCalled();
    expect(mocks.writeOAuthCredentials).not.toHaveBeenCalled();
  });
});
