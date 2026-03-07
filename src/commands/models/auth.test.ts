import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import { WizardCancelledError } from "../../wizard/prompts.js";
import { OPENAI_CODEX_DEFAULT_MODEL } from "../openai-codex-model-default.js";

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  isCancel: vi.fn(),
  clackConfirm: vi.fn(),
  clackSelect: vi.fn(),
  clackText: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
  resolveAgentDir: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveDefaultAgentWorkspaceDir: vi.fn(),
  resolvePluginProviders: vi.fn(),
  createClackPrompter: vi.fn(),
  loginOpenAICodexOAuth: vi.fn(),
  writeOAuthCredentials: vi.fn(),
  loadValidConfigOrThrow: vi.fn(),
  updateConfig: vi.fn(),
  logConfigUpdated: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  cancel: mocks.cancel,
  isCancel: mocks.isCancel,
  confirm: mocks.clackConfirm,
  select: mocks.clackSelect,
  text: mocks.clackText,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
  resolveAgentDir: mocks.resolveAgentDir,
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
}));

vi.mock("../../agents/workspace.js", () => ({
  resolveDefaultAgentWorkspaceDir: mocks.resolveDefaultAgentWorkspaceDir,
}));

vi.mock("../../plugins/providers.js", () => ({
  resolvePluginProviders: mocks.resolvePluginProviders,
}));

vi.mock("../../wizard/clack-prompter.js", () => ({
  createClackPrompter: mocks.createClackPrompter,
}));

vi.mock("../openai-codex-oauth.js", () => ({
  loginOpenAICodexOAuth: mocks.loginOpenAICodexOAuth,
}));

vi.mock("../onboard-auth.js", async (importActual) => {
  const actual = await importActual<typeof import("../onboard-auth.js")>();
  return {
    ...actual,
    writeOAuthCredentials: mocks.writeOAuthCredentials,
  };
});

vi.mock("./shared.js", async (importActual) => {
  const actual = await importActual<typeof import("./shared.js")>();
  return {
    ...actual,
    loadValidConfigOrThrow: mocks.loadValidConfigOrThrow,
    updateConfig: mocks.updateConfig,
  };
});

vi.mock("../../config/logging.js", () => ({
  logConfigUpdated: mocks.logConfigUpdated,
}));

vi.mock("../onboard-helpers.js", () => ({
  openUrl: mocks.openUrl,
}));

const { modelsAuthLoginCommand, modelsAuthPasteTokenCommand } = await import("./auth.js");

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function withInteractiveStdin() {
  const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
  const hadOwnIsTTY = Object.prototype.hasOwnProperty.call(stdin, "isTTY");
  const previousIsTTYDescriptor = Object.getOwnPropertyDescriptor(stdin, "isTTY");
  Object.defineProperty(stdin, "isTTY", {
    configurable: true,
    enumerable: true,
    get: () => true,
  });
  return () => {
    if (previousIsTTYDescriptor) {
      Object.defineProperty(stdin, "isTTY", previousIsTTYDescriptor);
    } else if (!hadOwnIsTTY) {
      delete (stdin as { isTTY?: boolean }).isTTY;
    }
  };
}

describe("models auth commands", () => {
  let restoreStdin: (() => void) | null = null;
  let currentConfig: OpenClawConfig;
  let lastUpdatedConfig: OpenClawConfig | null;

  beforeEach(() => {
    vi.clearAllMocks();
    restoreStdin = withInteractiveStdin();
    currentConfig = {};
    lastUpdatedConfig = null;

    mocks.clackConfirm.mockResolvedValue(true);
    mocks.clackSelect.mockResolvedValue("anthropic");
    mocks.clackText.mockResolvedValue("test-token");
    mocks.isCancel.mockReturnValue(false);
    mocks.resolveDefaultAgentId.mockReturnValue("main");
    mocks.resolveAgentDir.mockReturnValue("/tmp/openclaw/agents/main");
    mocks.resolveAgentWorkspaceDir.mockReturnValue("/tmp/openclaw/workspace");
    mocks.resolveDefaultAgentWorkspaceDir.mockReturnValue("/tmp/openclaw/workspace");
    mocks.loadValidConfigOrThrow.mockImplementation(async () => currentConfig);
    mocks.updateConfig.mockImplementation(
      async (mutator: (cfg: OpenClawConfig) => OpenClawConfig) => {
        lastUpdatedConfig = mutator(currentConfig);
        currentConfig = lastUpdatedConfig;
        return lastUpdatedConfig;
      },
    );
    mocks.createClackPrompter.mockReturnValue({
      note: vi.fn(async () => {}),
      select: vi.fn(),
    });
    mocks.loginOpenAICodexOAuth.mockResolvedValue({
      type: "oauth",
      provider: "openai-codex",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
      email: "user@example.com",
    });
    mocks.writeOAuthCredentials.mockResolvedValue("openai-codex:user@example.com");
    mocks.resolvePluginProviders.mockReturnValue([]);
  });

  afterEach(() => {
    restoreStdin?.();
    restoreStdin = null;
  });

  it("supports built-in openai-codex login without provider plugins", async () => {
    const runtime = createRuntime();

    await modelsAuthLoginCommand({ provider: "openai-codex" }, runtime);

    expect(mocks.loginOpenAICodexOAuth).toHaveBeenCalledOnce();
    expect(mocks.writeOAuthCredentials).toHaveBeenCalledWith(
      "openai-codex",
      expect.any(Object),
      "/tmp/openclaw/agents/main",
      { syncSiblingAgents: true },
    );
    expect(mocks.resolvePluginProviders).not.toHaveBeenCalled();
    expect(lastUpdatedConfig?.auth?.profiles?.["openai-codex:user@example.com"]).toMatchObject({
      provider: "openai-codex",
      mode: "oauth",
    });
    expect(runtime.log).toHaveBeenCalledWith(
      "Auth profile: openai-codex:user@example.com (openai-codex/oauth)",
    );
    expect(runtime.log).toHaveBeenCalledWith(
      `Default model available: ${OPENAI_CODEX_DEFAULT_MODEL} (use --set-default to apply)`,
    );
  });

  it("applies openai-codex default model when --set-default is used", async () => {
    const runtime = createRuntime();

    await modelsAuthLoginCommand({ provider: "openai-codex", setDefault: true }, runtime);

    expect(lastUpdatedConfig?.agents?.defaults?.model).toEqual({
      primary: OPENAI_CODEX_DEFAULT_MODEL,
    });
    expect(runtime.log).toHaveBeenCalledWith(`Default model set to ${OPENAI_CODEX_DEFAULT_MODEL}`);
  });

  it("keeps existing plugin error behavior for non built-in providers", async () => {
    const runtime = createRuntime();

    await expect(modelsAuthLoginCommand({ provider: "anthropic" }, runtime)).rejects.toThrow(
      "No provider plugins found.",
    );
  });

  it("throws WizardCancelledError and skips writes when token paste prompt is cancelled", async () => {
    const runtime = createRuntime();
    const cancelSymbol = Symbol.for("clack:cancel");
    mocks.clackText.mockResolvedValueOnce(cancelSymbol);
    mocks.isCancel.mockImplementation((value: unknown) => value === cancelSymbol);

    await expect(
      modelsAuthPasteTokenCommand({ provider: "openai", profileId: "openai:manual" }, runtime),
    ).rejects.toBeInstanceOf(WizardCancelledError);

    expect(mocks.updateConfig).not.toHaveBeenCalled();
    expect(mocks.logConfigUpdated).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
    expect(mocks.cancel).toHaveBeenCalled();
  });
});
