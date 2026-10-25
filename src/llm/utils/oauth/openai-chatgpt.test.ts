import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { OAuthLoginCallbacks } from "./types.js";

type LoginOpenAICodexOAuth =
  typeof import("../../../plugins/provider-openai-chatgpt-oauth.js").loginOpenAICodexOAuth;

const mocks = vi.hoisted(() => ({
  loginOpenAICodexOAuth: vi.fn<LoginOpenAICodexOAuth>(),
  loadActivatedBundledPluginPublicSurfaceModuleSync: vi.fn(),
  refreshOpenAICodexToken: vi.fn(),
  refreshProviderOAuthCredentialWithPlugin: vi.fn(),
}));

vi.mock("../../../plugins/provider-openai-chatgpt-oauth.js", () => ({
  loginOpenAICodexOAuth: mocks.loginOpenAICodexOAuth,
}));

vi.mock("../../../plugins/provider-runtime.runtime.js", () => ({
  refreshProviderOAuthCredentialWithPlugin: mocks.refreshProviderOAuthCredentialWithPlugin,
}));

vi.mock("../../../plugin-sdk/facade-runtime.js", () => ({
  loadActivatedBundledPluginPublicSurfaceModuleSync:
    mocks.loadActivatedBundledPluginPublicSurfaceModuleSync,
}));

import { openaiCodexOAuthProvider } from "./openai-chatgpt.js";

function login(callbacks: Partial<OAuthLoginCallbacks> = {}) {
  return openaiCodexOAuthProvider.login({
    onAuth: vi.fn(),
    onPrompt: vi.fn(async () => "manual-code"),
    ...callbacks,
  });
}

const expired = { access: "expired-access-token", refresh: "old-refresh-token", expires: 0 };
const tokens = {
  access: "access-token",
  refresh: "refresh-token",
  expires: 1_700_000_000_000,
  accountId: "acct_123",
};
const credential = { type: "oauth" as const, provider: "openai", ...tokens };

describe("OpenAI Codex OAuth compatibility provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadActivatedBundledPluginPublicSurfaceModuleSync.mockReturnValue({
      refreshOpenAICodexToken: mocks.refreshOpenAICodexToken,
    });
  });

  it("waits for the auth URL to render before requesting manual input", async () => {
    const authRendered = createDeferred();
    const onAuth = vi.fn(async () => authRendered.promise);
    const onPrompt = vi.fn(async () => "manual-code");
    mocks.loginOpenAICodexOAuth.mockImplementationOnce(async (params) => {
      await params.openUrl("https://auth.openai.com/oauth/authorize?state=abc");
      await params.prompter.text({ message: "Paste code" });
      return credential;
    });

    const pending = login({ onAuth, onPrompt });
    await vi.waitFor(() => expect(onAuth).toHaveBeenCalledOnce());
    expect(onPrompt).not.toHaveBeenCalled();

    authRendered.resolve();
    await expect(pending).resolves.toEqual(credential);
    expect(onPrompt).toHaveBeenCalledOnce();
  });

  it("passes legacy manual input through so it starts alongside browser auth", async () => {
    const onManualCodeInput = vi.fn(async () => "manual-code");
    mocks.loginOpenAICodexOAuth.mockImplementationOnce(async (params) => {
      await expect(params.onManualCodeInput?.()).resolves.toBe("manual-code");
      await expect(params.prompter.text({ message: "Fallback code" })).resolves.toBe(
        "fallback-code",
      );
      return credential;
    });

    await expect(
      login({
        onPrompt: vi.fn(async () => "fallback-code"),
        onManualCodeInput,
      }),
    ).resolves.toEqual(credential);

    expect(onManualCodeInput).toHaveBeenCalledOnce();
  });

  it("honors legacy login cancellation before opening OAuth", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(login({ signal: controller.signal })).rejects.toThrow("Login cancelled");
    expect(mocks.loginOpenAICodexOAuth).not.toHaveBeenCalled();
  });

  it("passes legacy cancellation into the provider auth hook", async () => {
    const controller = new AbortController();
    mocks.loginOpenAICodexOAuth.mockImplementationOnce(async (params) => {
      expect(params.signal).toBe(controller.signal);
      controller.abort();
      await expect(params.onManualCodeInput?.()).rejects.toThrow("Login cancelled");
      return credential;
    });

    await expect(
      login({
        onManualCodeInput: vi.fn(async () => "manual-code"),
        signal: controller.signal,
      }),
    ).rejects.toThrow("Login cancelled");
  });

  it("does not return completed credentials after login cancellation", async () => {
    const controller = new AbortController();
    mocks.loginOpenAICodexOAuth.mockImplementationOnce(() => {
      queueMicrotask(() => controller.abort());
      return Promise.resolve(credential);
    });

    await expect(login({ signal: controller.signal })).rejects.toThrow("Login cancelled");
  });

  it("honors legacy login cancellation before invoking the auth callback", async () => {
    const controller = new AbortController();
    const onAuth = vi.fn();
    mocks.loginOpenAICodexOAuth.mockImplementationOnce(async (params) => {
      controller.abort();
      await params.openUrl("https://auth.openai.com/oauth/authorize?state=abc");
      return credential;
    });

    await expect(login({ onAuth, signal: controller.signal })).rejects.toThrow("Login cancelled");
    expect(onAuth).not.toHaveBeenCalled();
  });

  it("refreshes through the provider runtime hook without returning auth-profile fields", async () => {
    mocks.refreshProviderOAuthCredentialWithPlugin.mockResolvedValueOnce(credential);

    await expect(openaiCodexOAuthProvider.refreshToken(expired)).resolves.toEqual(tokens);
    expect(mocks.refreshProviderOAuthCredentialWithPlugin).toHaveBeenCalledWith({
      provider: "openai",
      context: { ...expired, type: "oauth", provider: "openai" },
    });
    expect(mocks.loadActivatedBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
  });

  it("requires the plugin owner for flow-specific credentials instead of the standard facade", async () => {
    mocks.refreshProviderOAuthCredentialWithPlugin.mockResolvedValueOnce(null);

    await expect(
      openaiCodexOAuthProvider.refreshToken({
        ...expired,
        refresh: "shared-refresh-token",
        authFlow: "chatgpt-token-sharing",
      }),
    ).rejects.toThrow("OpenAI OAuth flow owner is unavailable");

    expect(mocks.refreshProviderOAuthCredentialWithPlugin).toHaveBeenCalledWith({
      provider: "openai",
      context: expect.objectContaining({ authFlow: "chatgpt-token-sharing" }),
    });
    expect(mocks.loadActivatedBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
    expect(mocks.refreshOpenAICodexToken).not.toHaveBeenCalled();
  });

  it("falls back to the OpenAI plugin facade when provider runtime refresh is unavailable", async () => {
    mocks.refreshProviderOAuthCredentialWithPlugin.mockResolvedValueOnce(null);
    mocks.refreshOpenAICodexToken.mockResolvedValueOnce(tokens);

    await expect(openaiCodexOAuthProvider.refreshToken(expired)).resolves.toEqual(tokens);

    expect(mocks.loadActivatedBundledPluginPublicSurfaceModuleSync).toHaveBeenCalledWith({
      dirName: "openai",
      artifactBasename: "api.js",
    });
    expect(mocks.refreshOpenAICodexToken).toHaveBeenCalledWith("old-refresh-token");
  });

  it("preserves activated-facade failures when refresh fallback is disabled", async () => {
    mocks.refreshProviderOAuthCredentialWithPlugin.mockResolvedValueOnce(null);
    mocks.loadActivatedBundledPluginPublicSurfaceModuleSync.mockImplementationOnce(() => {
      throw new Error("plugin runtime is not activated");
    });

    await expect(openaiCodexOAuthProvider.refreshToken(expired)).rejects.toThrow(
      "plugin runtime is not activated",
    );
    expect(mocks.refreshOpenAICodexToken).not.toHaveBeenCalled();
  });
});
