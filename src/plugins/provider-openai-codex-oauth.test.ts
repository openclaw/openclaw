import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

const mocks = vi.hoisted(() => ({
  loginOpenAICodex: vi.fn(),
  createVpsAwareOAuthHandlers: vi.fn(),
  runOpenAIOAuthTlsPreflight: vi.fn(),
  formatOpenAIOAuthTlsPreflightFix: vi.fn(),
  tryListenOnPort: vi.fn(),
  describePortOwner: vi.fn(),
}));

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  loginOpenAICodex: mocks.loginOpenAICodex,
}));

vi.mock("./provider-oauth-flow.js", () => ({
  createVpsAwareOAuthHandlers: mocks.createVpsAwareOAuthHandlers,
}));

vi.mock("./provider-openai-codex-oauth-tls.js", () => ({
  runOpenAIOAuthTlsPreflight: mocks.runOpenAIOAuthTlsPreflight,
  formatOpenAIOAuthTlsPreflightFix: mocks.formatOpenAIOAuthTlsPreflightFix,
}));

vi.mock("../infra/ports-probe.js", () => ({
  tryListenOnPort: mocks.tryListenOnPort,
}));

vi.mock("../infra/ports.js", () => ({
  describePortOwner: mocks.describePortOwner,
}));

import { loginOpenAICodexOAuth } from "./provider-openai-codex-oauth.js";

function createPrompter() {
  const spin = { update: vi.fn(), stop: vi.fn() };
  const prompter: Pick<WizardPrompter, "note" | "progress"> = {
    note: vi.fn(async () => {}),
    progress: vi.fn(() => spin),
  };
  return { prompter: prompter as unknown as WizardPrompter, spin };
}

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    }),
  };
}

async function runCodexOAuth(params: { isRemote: boolean }) {
  const { prompter, spin } = createPrompter();
  const runtime = createRuntime();
  const result = await loginOpenAICodexOAuth({
    prompter,
    runtime,
    isRemote: params.isRemote,
    openUrl: async () => {},
  });
  return { result, prompter, spin, runtime };
}

describe("loginOpenAICodexOAuth – port conflict", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runOpenAIOAuthTlsPreflight.mockResolvedValue({ ok: true });
    mocks.tryListenOnPort.mockResolvedValue(undefined);
    mocks.describePortOwner.mockResolvedValue(undefined);
  });

  it("does not activate manual fallback when the callback port is free", async () => {
    const creds = {
      provider: "openai-codex" as const,
      access: "a",
      refresh: "r",
      expires: Date.now() + 60_000,
      email: "u@example.com",
    };
    mocks.createVpsAwareOAuthHandlers.mockReturnValue({ onAuth: vi.fn(), onPrompt: vi.fn() });
    mocks.loginOpenAICodex.mockResolvedValue(creds);

    await runCodexOAuth({ isRemote: false });

    expect(mocks.tryListenOnPort).toHaveBeenCalledWith({
      port: 1455,
      host: "127.0.0.1",
      exclusive: true,
    });
    expect(mocks.loginOpenAICodex.mock.calls[0]?.[0]?.onManualCodeInput).toBeUndefined();
  });

  it("enables immediate manual fallback when the callback port is occupied with known owner", async () => {
    const creds = {
      provider: "openai-codex" as const,
      access: "a",
      refresh: "r",
      expires: Date.now() + 60_000,
      email: "u@example.com",
    };
    mocks.tryListenOnPort.mockRejectedValue(
      Object.assign(new Error("address in use"), { code: "EADDRINUSE" }),
    );
    mocks.describePortOwner.mockResolvedValue("Code Helper (Plugin)");
    mocks.createVpsAwareOAuthHandlers.mockReturnValue({ onAuth: vi.fn(), onPrompt: vi.fn() });
    mocks.loginOpenAICodex.mockResolvedValue(creds);

    const { prompter } = await runCodexOAuth({ isRemote: false });

    expect(mocks.describePortOwner).toHaveBeenCalledWith(1455);
    expect(mocks.loginOpenAICodex.mock.calls[0]?.[0]?.onManualCodeInput).toEqual(
      expect.any(Function),
    );
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("Code Helper (Plugin)"),
      "OpenAI Codex OAuth",
    );
  });

  it("enables manual fallback without owner details when describePortOwner returns undefined", async () => {
    const creds = {
      provider: "openai-codex" as const,
      access: "a",
      refresh: "r",
      expires: Date.now() + 60_000,
      email: "u@example.com",
    };
    mocks.tryListenOnPort.mockRejectedValue(
      Object.assign(new Error("address in use"), { code: "EADDRINUSE" }),
    );
    mocks.describePortOwner.mockResolvedValue(undefined);
    mocks.createVpsAwareOAuthHandlers.mockReturnValue({ onAuth: vi.fn(), onPrompt: vi.fn() });
    mocks.loginOpenAICodex.mockResolvedValue(creds);

    const { prompter } = await runCodexOAuth({ isRemote: false });

    expect(mocks.loginOpenAICodex.mock.calls[0]?.[0]?.onManualCodeInput).toEqual(
      expect.any(Function),
    );
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("localhost:1455"),
      "OpenAI Codex OAuth",
    );
    expect(prompter.note).not.toHaveBeenCalledWith(
      expect.stringContaining("Port listener details:"),
      "OpenAI Codex OAuth",
    );
  });

  it("ignores non-EADDRINUSE probe failures and proceeds without manual fallback", async () => {
    const creds = {
      provider: "openai-codex" as const,
      access: "a",
      refresh: "r",
      expires: Date.now() + 60_000,
      email: "u@example.com",
    };
    mocks.tryListenOnPort.mockRejectedValue(
      Object.assign(new Error("address not available"), { code: "EADDRNOTAVAIL" }),
    );
    mocks.createVpsAwareOAuthHandlers.mockReturnValue({ onAuth: vi.fn(), onPrompt: vi.fn() });
    mocks.loginOpenAICodex.mockResolvedValue(creds);

    await runCodexOAuth({ isRemote: false });

    expect(mocks.describePortOwner).not.toHaveBeenCalled();
    expect(mocks.loginOpenAICodex.mock.calls[0]?.[0]?.onManualCodeInput).toBeUndefined();
  });

  it("skips port preflight in remote mode", async () => {
    const creds = {
      provider: "openai-codex" as const,
      access: "a",
      refresh: "r",
      expires: Date.now() + 60_000,
      email: "u@example.com",
    };
    mocks.createVpsAwareOAuthHandlers.mockReturnValue({ onAuth: vi.fn(), onPrompt: vi.fn() });
    mocks.loginOpenAICodex.mockResolvedValue(creds);

    await runCodexOAuth({ isRemote: true });

    expect(mocks.tryListenOnPort).not.toHaveBeenCalled();
    expect(mocks.describePortOwner).not.toHaveBeenCalled();
  });
});
