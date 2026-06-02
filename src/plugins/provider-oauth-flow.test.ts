import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { createVpsAwareOAuthHandlers } from "./provider-oauth-flow.js";

function createPrompter(text: WizardPrompter["text"]): WizardPrompter {
  return {
    intro: vi.fn(async () => undefined),
    outro: vi.fn(async () => undefined),
    note: vi.fn(async () => undefined),
    select: vi.fn(async (params) => params.options[0]?.value),
    multiselect: vi.fn(async () => []),
    text,
    confirm: vi.fn(async () => false),
    progress: vi.fn(() => ({
      update: vi.fn(),
      stop: vi.fn(),
    })),
  };
}

describe("createVpsAwareOAuthHandlers", () => {
  it("defers remote manual prompts until the abort signal is available", async () => {
    const text = vi.fn(async () => "callback-code");
    const promptSignal = new AbortController().signal;
    const handlers = createVpsAwareOAuthHandlers({
      isRemote: true,
      prompter: createPrompter(text),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } satisfies RuntimeEnv,
      spin: { update: vi.fn(), stop: vi.fn() },
      openUrl: vi.fn(async () => undefined),
      localBrowserMessage: "Complete sign-in in browser...",
    });

    await handlers.onAuth({ url: "https://auth.openai.com/oauth/authorize" });
    expect(text).not.toHaveBeenCalled();

    await expect(
      handlers.onPrompt({
        message: "Paste the authorization code:",
        signal: promptSignal,
      }),
    ).resolves.toBe("callback-code");

    expect(text).toHaveBeenCalledWith({
      message: "Paste the authorization code:",
      placeholder: undefined,
      signal: promptSignal,
      validate: expect.any(Function),
    });
  });

  it("forwards manual prompt cancellation signals to text prompts", async () => {
    const text = vi.fn(async () => "callback-code");
    const promptSignal = new AbortController().signal;
    const handlers = createVpsAwareOAuthHandlers({
      isRemote: false,
      prompter: createPrompter(text),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } satisfies RuntimeEnv,
      spin: { update: vi.fn(), stop: vi.fn() },
      openUrl: vi.fn(async () => undefined),
      localBrowserMessage: "Complete sign-in in browser...",
    });

    await expect(
      handlers.onPrompt({
        message: "Paste the authorization code:",
        placeholder: "http://localhost:1455/auth/callback",
        signal: promptSignal,
      }),
    ).resolves.toBe("callback-code");

    expect(text).toHaveBeenCalledWith({
      message: "Paste the authorization code:",
      placeholder: "http://localhost:1455/auth/callback",
      signal: promptSignal,
      validate: expect.any(Function),
    });
  });
});
