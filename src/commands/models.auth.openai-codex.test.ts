import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAuthTestLifecycle,
  createExitThrowingRuntime,
  createWizardPrompter,
  setupAuthTestEnv,
} from "./test-wizard-helpers.js";

const loginOpenAICodexOAuth = vi.hoisted(() => vi.fn());
vi.mock("./openai-codex-oauth.js", () => ({
  loginOpenAICodexOAuth,
}));

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const writeConfigFileMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  writeConfigFile: writeConfigFileMock,
}));

const wizardMocks = vi.hoisted(() => ({
  createClackPrompter: vi.fn(),
}));
vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: wizardMocks.createClackPrompter,
}));

const writeOAuthCredentialsMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("./onboard-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./onboard-auth.js")>()),
  writeOAuthCredentials: writeOAuthCredentialsMock,
}));

vi.mock("./oauth-env.js", () => ({
  isRemoteEnvironment: vi.fn(() => false),
}));

vi.mock("./onboard-helpers.js", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

import { modelsAuthLoginCommand } from "./models/auth.js";
import { baseConfigSnapshot } from "./test-runtime-config-helpers.js";

describe("modelsAuthLoginCommand with openai-codex provider", () => {
  const lifecycle = createAuthTestLifecycle([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
  ]);

  const originalIsTTY = process.stdin.isTTY;

  async function setupTempState() {
    const env = await setupAuthTestEnv("openclaw-codex-auth-");
    lifecycle.setStateDir(env.stateDir);
    return env.agentDir;
  }

  const validSnapshot = {
    ...baseConfigSnapshot,
    valid: true as const,
    config: {},
  };

  beforeEach(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    readConfigFileSnapshotMock.mockReset();
    readConfigFileSnapshotMock.mockResolvedValue(validSnapshot);
    writeConfigFileMock.mockClear();
    writeConfigFileMock.mockResolvedValue(undefined);
    writeOAuthCredentialsMock.mockClear();
    loginOpenAICodexOAuth.mockReset();
    wizardMocks.createClackPrompter.mockReturnValue(createWizardPrompter({}));
  });

  afterEach(async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
    await lifecycle.cleanup();
  });

  it("routes --provider openai-codex to built-in OAuth flow", async () => {
    await setupTempState();
    const creds = {
      provider: "openai-codex" as const,
      access: "test-access-token",
      refresh: "test-refresh-token",
      expires: Date.now() + 60_000,
      email: "user@example.com",
    };
    loginOpenAICodexOAuth.mockResolvedValue(creds);

    const runtime = createExitThrowingRuntime();
    await modelsAuthLoginCommand({ provider: "openai-codex" }, runtime);

    expect(loginOpenAICodexOAuth).toHaveBeenCalledOnce();
    expect(writeOAuthCredentialsMock).toHaveBeenCalledWith(
      "openai-codex",
      creds,
      expect.any(String),
    );
    expect(writeConfigFileMock).toHaveBeenCalled();

    const written = writeConfigFileMock.mock.calls[0][0];
    expect(written.auth?.profiles).toHaveProperty("openai-codex:default");
    expect(runtime.log).toHaveBeenCalledWith(
      "Auth profile: openai-codex:default (openai-codex/oauth)",
    );
  });

  it("does nothing when OAuth flow is cancelled", async () => {
    await setupTempState();
    loginOpenAICodexOAuth.mockResolvedValue(null);

    const runtime = createExitThrowingRuntime();
    await modelsAuthLoginCommand({ provider: "openai-codex" }, runtime);

    expect(loginOpenAICodexOAuth).toHaveBeenCalledOnce();
    expect(writeConfigFileMock).not.toHaveBeenCalled();
  });

  it("applies default model when --set-default is passed", async () => {
    await setupTempState();
    loginOpenAICodexOAuth.mockResolvedValue({
      provider: "openai-codex" as const,
      access: "tok",
      refresh: "ref",
      expires: Date.now() + 60_000,
    });

    const runtime = createExitThrowingRuntime();
    await modelsAuthLoginCommand({ provider: "openai-codex", setDefault: true }, runtime);

    const written = writeConfigFileMock.mock.calls[0][0];
    expect(written.agents?.defaults?.model?.primary).toBe("openai-codex/gpt-5.3-codex");
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("Default model set to"));
  });

  it("does not set default model without --set-default", async () => {
    await setupTempState();
    loginOpenAICodexOAuth.mockResolvedValue({
      provider: "openai-codex" as const,
      access: "tok",
      refresh: "ref",
      expires: Date.now() + 60_000,
    });

    const runtime = createExitThrowingRuntime();
    await modelsAuthLoginCommand({ provider: "openai-codex" }, runtime);

    const written = writeConfigFileMock.mock.calls[0][0];
    expect(written.agents?.defaults?.model?.primary).toBeUndefined();
  });
});
