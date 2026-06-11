import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { createVpsAwareOAuthHandlers } from "./provider-oauth-flow.js";

const AUTH_URL = "https://auth.example.test/oauth/authorize?state=abc";

function createOAuthHarness(params: { isRemote: boolean }) {
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
  it("includes the authorization URL in remote OAuth text prompts", async () => {
    const { handlers, text } = createOAuthHarness({
      isRemote: true,
    });

    await handlers.onAuth({ url: AUTH_URL });

    expect(text).toHaveBeenCalledWith({
      message: [
        "Open this URL in your LOCAL browser:",
        "",
        AUTH_URL,
        "",
        "Paste the redirect URL",
      ].join("\n"),
      validate: expect.any(Function),
    });
  });

  it("includes the authorization URL in local fallback prompts", async () => {
    const { handlers, text } = createOAuthHarness({
      isRemote: false,
    });

    await handlers.onAuth({ url: AUTH_URL });
    await handlers.onPrompt({ message: "Paste the redirect URL", placeholder: "http://localhost" });

    expect(text).toHaveBeenCalledWith({
      message: [
        "Open this URL in your LOCAL browser:",
        "",
        AUTH_URL,
        "",
        "Paste the redirect URL",
      ].join("\n"),
      placeholder: "http://localhost",
      validate: expect.any(Function),
    });
  });

  it("keeps local fallback prompts unchanged before an auth URL is available", async () => {
    const { handlers, text } = createOAuthHarness({ isRemote: false });

    await handlers.onPrompt({ message: "Paste the redirect URL" });

    expect(text).toHaveBeenCalledWith({
      message: "Paste the redirect URL",
      validate: expect.any(Function),
    });
  });
});
