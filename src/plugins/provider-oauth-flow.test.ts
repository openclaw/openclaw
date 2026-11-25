import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { createVpsAwareOAuthHandlers } from "./provider-oauth-flow.js";

describe("createVpsAwareOAuthHandlers", () => {
  it.each([true, false])(
    "asks for the pasted address in plain text while forwarding URLs (remote=%s)",
    async (isRemote) => {
      const note = vi.fn(async () => undefined);
      const text = vi.fn(
        async (_params: Parameters<WizardPrompter["text"]>[0]) => "callback-value",
      );
      const openUrl = vi.fn(async () => undefined);
      const spin = { update: vi.fn(), stop: vi.fn() };
      const handlers = createVpsAwareOAuthHandlers({
        isRemote,
        prompter: { note, text } as unknown as WizardPrompter,
        runtime: { log: vi.fn() } as unknown as RuntimeEnv,
        spin: spin as ReturnType<WizardPrompter["progress"]>,
        openUrl,
        localBrowserMessage: "Opening browser",
      });

      await handlers.onAuth({ url: "https://provider.example/oauth?state=state-1" });

      expect(openUrl).toHaveBeenCalledWith("https://provider.example/oauth?state=state-1");
      // The Gateway step carries the URL; a second note would only repeat it.
      expect(note).not.toHaveBeenCalled();
      await expect(handlers.onPrompt({ message: "Paste callback" })).resolves.toBe(
        "callback-value",
      );
      expect(text).toHaveBeenCalledOnce();
      expect(text.mock.calls[0]![0].sensitive).toBeUndefined();
    },
  );

  it("keeps the paste open for an answer that does not belong to this sign-in", async () => {
    const text = vi.fn(async (_params: Parameters<WizardPrompter["text"]>[0]) => "");
    const handlers = createVpsAwareOAuthHandlers({
      isRemote: true,
      prompter: { note: vi.fn(), text } as unknown as WizardPrompter,
      runtime: { log: vi.fn() } as unknown as RuntimeEnv,
      spin: { update: vi.fn(), stop: vi.fn() } as ReturnType<WizardPrompter["progress"]>,
      openUrl: vi.fn(async () => undefined),
      localBrowserMessage: "Opening browser",
    });
    const signIn =
      "https://provider.example/oauth?state=s1&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fcb";
    await handlers.onAuth({ url: signIn });
    const params = text.mock.calls[0]![0];
    const validate = params.validate!;

    // The SDK parser owns every format; this proves the step binds it to this attempt.
    expect(params.placeholder).toBe("http://127.0.0.1:1455/cb?code=...&state=...");
    expect(validate("c1#s1")).toBeUndefined();
    expect(validate("c1#other")).toMatch(/different sign-in attempt/);
    expect(validate("error=access_denied")).toMatch(/Sign-in was not allowed/);
    expect(validate(signIn)).toMatch(/That is the sign-in page/);
  });

  it("forwards prompt cancellation to remote manual entry", async () => {
    const controller = new AbortController();
    const text = vi.fn(
      (params: { signal?: AbortSignal }) =>
        new Promise<string>((_resolve, reject) => {
          params.signal?.addEventListener("abort", () => reject(new Error("prompt aborted")), {
            once: true,
          });
        }),
    );
    const handlers = createVpsAwareOAuthHandlers({
      isRemote: true,
      prompter: {
        note: vi.fn(async () => undefined),
        text,
      } as unknown as WizardPrompter,
      runtime: { log: vi.fn() } as unknown as RuntimeEnv,
      spin: { update: vi.fn(), stop: vi.fn() } as ReturnType<WizardPrompter["progress"]>,
      openUrl: vi.fn(async () => undefined),
      localBrowserMessage: "Opening browser",
      manualPromptSignal: controller.signal,
    });

    await handlers.onAuth({ url: "https://provider.example/oauth?state=state-1" });
    controller.abort();
    // The provider may not request manual input until after cancellation wins.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    const prompt = handlers.onPrompt({ message: "Paste callback" });

    await expect(prompt).rejects.toThrow("prompt aborted");
    expect(text).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
  });
});
