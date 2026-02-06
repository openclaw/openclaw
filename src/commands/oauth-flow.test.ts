import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { createVpsAwareOAuthHandlers } from "./oauth-flow.js";

describe("createVpsAwareOAuthHandlers", () => {
  it("prompts once when remote onAuth is called multiple times", async () => {
    const text = vi.fn(async () => "code_manual");
    const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const spin = { update: vi.fn(), stop: vi.fn() };
    const prompter: WizardPrompter = {
      intro: vi.fn(async () => {}),
      outro: vi.fn(async () => {}),
      note: vi.fn(async () => {}),
      select: vi.fn(async () => "" as never),
      multiselect: vi.fn(async () => []),
      text,
      confirm: vi.fn(async () => false),
      progress: vi.fn(() => spin),
    };

    const handlers = createVpsAwareOAuthHandlers({
      isRemote: true,
      prompter,
      runtime,
      spin,
      openUrl: async () => undefined,
      localBrowserMessage: "Complete sign-in in browser…",
    });

    await handlers.onAuth({ url: "https://example.com/first" });
    await handlers.onAuth({ url: "https://example.com/second" });

    expect(text).toHaveBeenCalledTimes(1);
    await expect(handlers.onPrompt({ message: "code" })).resolves.toBe("code_manual");
    await expect(handlers.onPrompt({ message: "code" })).resolves.toBe("code_manual");
    expect(spin.stop).toHaveBeenCalledTimes(1);
  });
});
