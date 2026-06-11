import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { createVpsAwareOAuthHandlers } from "./provider-oauth-flow.js";

const AUTH_URL = "https://auth.example.test/oauth/authorize?state=abc";

function createOAuthHarness(params: { isRemote: boolean; provider?: string }) {
  const spin = { update: vi.fn(), stop: vi.fn() };
  const text = vi.fn(async () => "http://localhost/callback?code=test");
  const prompter = {
    text,
  } as unknown as WizardPrompter;
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    }),
  } satisfies RuntimeEnv;
  const openUrl = vi.fn(async () => {});
  const handlers = createVpsAwareOAuthHandlers({
    isRemote: params.isRemote,
    provider: params.provider,
    prompter,
    runtime,
    spin,
    openUrl,
    localBrowserMessage: "Complete sign-in in browser...",
    manualPromptMessage: "Paste the redirect URL",
  });
  return { handlers, text, openUrl };
}

describe("createVpsAwareOAuthHandlers", () => {
  it("includes provider metadata on remote OAuth text prompts when configured", async () => {
    const { handlers, text } = createOAuthHarness({
      isRemote: true,
      provider: "openai-codex",
    });

    await handlers.onAuth({ url: AUTH_URL });

    expect(text).toHaveBeenCalledWith({
      message: "Paste the redirect URL",
      auth: {
        kind: "oauth-redirect",
        url: AUTH_URL,
        provider: "openai-codex",
      },
      validate: expect.any(Function),
    });
  });

  it("includes provider metadata on local fallback prompts when configured", async () => {
    const { handlers, text } = createOAuthHarness({
      isRemote: false,
      provider: "chutes",
    });

    await handlers.onAuth({ url: AUTH_URL });
    await handlers.onPrompt({ message: "Paste the redirect URL", placeholder: "http://localhost" });

    expect(text).toHaveBeenCalledWith({
      message: "Paste the redirect URL",
      placeholder: "http://localhost",
      auth: {
        kind: "oauth-redirect",
        url: AUTH_URL,
        provider: "chutes",
      },
      validate: expect.any(Function),
    });
  });

  it("omits provider metadata when none is configured", async () => {
    const { handlers, text } = createOAuthHarness({ isRemote: true });

    await handlers.onAuth({ url: AUTH_URL });

    expect(text).toHaveBeenCalledWith({
      message: "Paste the redirect URL",
      auth: {
        kind: "oauth-redirect",
        url: AUTH_URL,
      },
      validate: expect.any(Function),
    });
  });
});
