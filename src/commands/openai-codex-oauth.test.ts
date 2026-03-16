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

vi.mock("./oauth-flow.js", () => ({
  createVpsAwareOAuthHandlers: mocks.createVpsAwareOAuthHandlers,
}));

vi.mock("./oauth-tls-preflight.js", () => ({
  runOpenAIOAuthTlsPreflight: mocks.runOpenAIOAuthTlsPreflight,
  formatOpenAIOAuthTlsPreflightFix: mocks.formatOpenAIOAuthTlsPreflightFix,
}));

vi.mock("../infra/ports-probe.js", () => ({
  tryListenOnPort: mocks.tryListenOnPort,
}));

vi.mock("../infra/ports.js", () => ({
  describePortOwner: mocks.describePortOwner,
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

describe("loginOpenAICodexOAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runOpenAIOAuthTlsPreflight.mockResolvedValue({ ok: true });
    mocks.formatOpenAIOAuthTlsPreflightFix.mockReturnValue("tls fix");
    mocks.tryListenOnPort.mockResolvedValue(undefined);
    mocks.describePortOwner.mockResolvedValue(undefined);
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

    const { result, spin, runtime } = await runCodexOAuth({ isRemote: false });

    expect(result).toEqual(creds);
    expect(mocks.loginOpenAICodex).toHaveBeenCalledOnce();
    expect(mocks.tryListenOnPort).toHaveBeenCalledWith({
      port: 1455,
      host: "127.0.0.1",
      exclusive: true,
    });
    expect(mocks.loginOpenAICodex.mock.calls[0]?.[0]?.onManualCodeInput).toBeUndefined();
    expect(spin.stop).toHaveBeenCalledWith("OpenAI OAuth complete");
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("passes through Pi-provided OAuth authorize URL without mutation", async () => {
    const creds = {
      provider: "openai-codex" as const,
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
      email: "user@example.com",
    };
    const onAuthSpy = vi.fn();
    mocks.createVpsAwareOAuthHandlers.mockReturnValue({
      onAuth: onAuthSpy,
      onPrompt: vi.fn(),
    });
    mocks.loginOpenAICodex.mockImplementation(
      async (opts: { onAuth: (event: { url: string }) => Promise<void> }) => {
        await opts.onAuth({
          url: "https://auth.openai.com/oauth/authorize?scope=openid+profile+email+offline_access&state=abc",
        });
        return creds;
      },
    );

    await runCodexOAuth({ isRemote: false });

    expect(onAuthSpy).toHaveBeenCalledTimes(1);
    const event = onAuthSpy.mock.calls[0]?.[0] as { url: string };
    expect(event.url).toBe(
      "https://auth.openai.com/oauth/authorize?scope=openid+profile+email+offline_access&state=abc",
    );
  });

  it("enables immediate manual fallback when localhost callback port is already occupied", async () => {
    const creds = {
      provider: "openai-codex" as const,
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
      email: "user@example.com",
    };
    mocks.tryListenOnPort.mockRejectedValue(
      Object.assign(new Error("address in use"), { code: "EADDRINUSE" }),
    );
    mocks.describePortOwner.mockResolvedValue("Code Helper (Plugin)");
    mocks.createVpsAwareOAuthHandlers.mockReturnValue({
      onAuth: vi.fn(),
      onPrompt: vi.fn(),
    });
    mocks.loginOpenAICodex.mockResolvedValue(creds);

    const { prompter } = await runCodexOAuth({ isRemote: false });

    expect(mocks.describePortOwner).toHaveBeenCalledWith(1455);
    expect(mocks.loginOpenAICodex.mock.calls[0]?.[0]?.onManualCodeInput).toEqual(
      expect.any(Function),
    );
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("localhost:1455"),
      "OpenAI Codex OAuth",
    );
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("Code Helper (Plugin)"),
      "OpenAI Codex OAuth",
    );
  });

  it("skips localhost callback preflight in remote mode", async () => {
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

    await runCodexOAuth({ isRemote: true });

    expect(mocks.tryListenOnPort).not.toHaveBeenCalled();
    expect(mocks.describePortOwner).not.toHaveBeenCalled();
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

  it("continues OAuth flow on non-certificate preflight failures", async () => {
    const creds = {
      provider: "openai-codex" as const,
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
      email: "user@example.com",
    };
    mocks.runOpenAIOAuthTlsPreflight.mockResolvedValue({
      ok: false,
      kind: "network",
      message: "Client network socket disconnected before secure TLS connection was established",
    });
    mocks.createVpsAwareOAuthHandlers.mockReturnValue({
      onAuth: vi.fn(),
      onPrompt: vi.fn(),
    });
    mocks.loginOpenAICodex.mockResolvedValue(creds);

    const { result, prompter, runtime } = await runCodexOAuth({ isRemote: false });

    expect(result).toEqual(creds);
    expect(mocks.loginOpenAICodex).toHaveBeenCalledOnce();
    expect(runtime.error).not.toHaveBeenCalledWith("tls fix");
    expect(prompter.note).not.toHaveBeenCalledWith("tls fix", "OAuth prerequisites");
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
