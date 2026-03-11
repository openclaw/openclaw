import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

const mocks = vi.hoisted(() => ({
  loginOpenAICodex: vi.fn(),
  createVpsAwareOAuthHandlers: vi.fn(),
  runOpenAIOAuthTlsPreflight: vi.fn(),
  formatOpenAIOAuthTlsPreflightFix: vi.fn(),
  setGlobalDispatcher: vi.fn(),
  getGlobalDispatcher: vi.fn(() => ({ kind: "original" })),
  EnvHttpProxyAgent: vi.fn(function MockEnvHttpProxyAgent(this: unknown) {
    return { kind: "env-proxy", self: this };
  }),
}));

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  loginOpenAICodex: mocks.loginOpenAICodex,
}));

vi.mock("undici", () => ({
  EnvHttpProxyAgent: mocks.EnvHttpProxyAgent,
  getGlobalDispatcher: mocks.getGlobalDispatcher,
  setGlobalDispatcher: mocks.setGlobalDispatcher,
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
  const PROXY_ENV_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] as const;
  const prevProxyEnv = Object.fromEntries(
    PROXY_ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<(typeof PROXY_ENV_KEYS)[number], string | undefined>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runOpenAIOAuthTlsPreflight.mockResolvedValue({ ok: true });
    mocks.formatOpenAIOAuthTlsPreflightFix.mockReturnValue("tls fix");
    for (const key of PROXY_ENV_KEYS) {
      if (prevProxyEnv[key] == null) {
        delete process.env[key];
      } else {
        process.env[key] = prevProxyEnv[key];
      }
    }
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

  it("installs EnvHttpProxyAgent around oauth when proxy env is configured", async () => {
    process.env.HTTPS_PROXY = "http://127.0.0.1:7890";
    const creds = {
      provider: "openai-codex" as const,
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
      email: "user@example.com",
    };
    mocks.createVpsAwareOAuthHandlers.mockReturnValue({ onAuth: vi.fn(), onPrompt: vi.fn() });
    mocks.loginOpenAICodex.mockResolvedValue(creds);

    await runCodexOAuth({ isRemote: false });

    expect(mocks.EnvHttpProxyAgent).toHaveBeenCalledTimes(1);
    expect(mocks.setGlobalDispatcher).toHaveBeenCalledTimes(2);
    expect(mocks.setGlobalDispatcher.mock.calls[0]?.[0]).toMatchObject({ kind: "env-proxy" });
    expect(mocks.setGlobalDispatcher.mock.calls[1]?.[0]).toEqual({ kind: "original" });
  });

  it("restores dispatcher after oauth failure under proxy env", async () => {
    process.env.HTTPS_PROXY = "http://127.0.0.1:7890";
    mocks.createVpsAwareOAuthHandlers.mockReturnValue({ onAuth: vi.fn(), onPrompt: vi.fn() });
    mocks.loginOpenAICodex.mockRejectedValue(new Error("oauth failed"));

    await expect(runCodexOAuth({ isRemote: false })).rejects.toThrow("oauth failed");

    expect(mocks.setGlobalDispatcher).toHaveBeenCalledTimes(2);
    expect(mocks.setGlobalDispatcher.mock.calls[1]?.[0]).toEqual({ kind: "original" });
  });

  it("falls back to direct transport when proxy dispatcher setup fails", async () => {
    process.env.HTTPS_PROXY = "bad-proxy-url";
    const creds = {
      provider: "openai-codex" as const,
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
      email: "user@example.com",
    };
    mocks.EnvHttpProxyAgent.mockImplementationOnce(() => {
      throw new Error("invalid proxy url");
    });
    mocks.createVpsAwareOAuthHandlers.mockReturnValue({ onAuth: vi.fn(), onPrompt: vi.fn() });
    mocks.loginOpenAICodex.mockResolvedValue(creds);

    const { result, runtime } = await runCodexOAuth({ isRemote: false });

    expect(result).toEqual(creds);
    expect(mocks.setGlobalDispatcher).not.toHaveBeenCalled();
    expect(mocks.loginOpenAICodex).toHaveBeenCalledOnce();
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("proxy dispatcher setup failed; falling back to direct transport"),
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
