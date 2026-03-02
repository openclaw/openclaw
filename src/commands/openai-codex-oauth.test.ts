import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

const mocks = vi.hoisted(() => ({
  loginOpenAICodex: vi.fn(),
  createVpsAwareOAuthHandlers: vi.fn(),
  runOpenAIOAuthTlsPreflight: vi.fn(),
  formatOpenAIOAuthTlsPreflightFix: vi.fn(),
}));

vi.mock("@mariozechner/pi-ai", () => ({
  loginOpenAICodex: mocks.loginOpenAICodex,
}));

vi.mock("./oauth-flow.js", () => ({
  createVpsAwareOAuthHandlers: mocks.createVpsAwareOAuthHandlers,
}));

vi.mock("./oauth-tls-preflight.js", () => ({
  runOpenAIOAuthTlsPreflight: mocks.runOpenAIOAuthTlsPreflight,
  formatOpenAIOAuthTlsPreflightFix: mocks.formatOpenAIOAuthTlsPreflightFix,
}));

import { loginOpenAICodexOAuth } from "./openai-codex-oauth.js";

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

describe("loginOpenAICodexOAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runOpenAIOAuthTlsPreflight.mockResolvedValue({ ok: true });
    mocks.formatOpenAIOAuthTlsPreflightFix.mockReturnValue("tls fix");
  });

  it("returns credentials on successful oauth login", async () => {
    const creds = {
      provider: "openai-codex" as const,
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
      email: "user@example.com",
    };
    mocks.createVpsAwareOAuthHandlers.mockReturnValue({
      onAuth: vi.fn(),
      onPrompt: vi.fn(),
    });
    mocks.loginOpenAICodex.mockResolvedValue(creds);

    const { prompter, spin } = createPrompter();
    const runtime = createRuntime();
    const result = await loginOpenAICodexOAuth({
      prompter,
      runtime,
      isRemote: false,
      openUrl: async () => {},
    });

    expect(result).toEqual(creds);
    expect(mocks.loginOpenAICodex).toHaveBeenCalledOnce();
    expect(spin.stop).toHaveBeenCalledWith("OpenAI OAuth complete");
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("reports oauth errors and rethrows", async () => {
    mocks.createVpsAwareOAuthHandlers.mockReturnValue({
      onAuth: vi.fn(),
      onPrompt: vi.fn(),
    });
    mocks.loginOpenAICodex.mockRejectedValue(new Error("oauth failed"));

    const { prompter, spin } = createPrompter();
    const runtime = createRuntime();
    await expect(
      loginOpenAICodexOAuth({
        prompter,
        runtime,
        isRemote: true,
        openUrl: async () => {},
      }),
    ).rejects.toThrow("oauth failed");

    expect(spin.stop).toHaveBeenCalledWith("OpenAI OAuth failed");
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("oauth failed"));
    expect(prompter.note).toHaveBeenCalledWith(
      "Trouble with OAuth? See https://docs.openclaw.ai/start/faq",
      "OAuth help",
    );
  });

  it("fails early with actionable message when TLS preflight fails", async () => {
    mocks.runOpenAIOAuthTlsPreflight.mockResolvedValue({
      ok: false,
      kind: "tls-cert",
      code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      message: "unable to get local issuer certificate",
    });
    mocks.formatOpenAIOAuthTlsPreflightFix.mockReturnValue("Run brew postinstall openssl@3");

    const { prompter } = createPrompter();
    const runtime = createRuntime();

    await expect(
      loginOpenAICodexOAuth({
        prompter,
        runtime,
        isRemote: false,
        openUrl: async () => {},
      }),
    ).rejects.toThrow("unable to get local issuer certificate");

    expect(mocks.loginOpenAICodex).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith("Run brew postinstall openssl@3");
    expect(prompter.note).toHaveBeenCalledWith(
      "Run brew postinstall openssl@3",
      "OAuth prerequisites",
    );
  });
});
