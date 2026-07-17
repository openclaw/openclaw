import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearPluginInteractiveHandlers,
  dispatchPluginInteractiveHandler,
  registerPluginInteractiveHandler,
} from "./interactive.js";

describe("plugin interactive submitText results", () => {
  afterEach(() => {
    clearPluginInteractiveHandlers();
  });

  it("runs channel post-processing exactly once for a deduped interaction", async () => {
    const result = { handled: true, submitText: "Continue in this thread" };
    const handler = vi.fn(async () => result);
    const afterInvoke = vi.fn(async () => {});
    expect(
      registerPluginInteractiveHandler("quick-replies-plugin", {
        channel: "discord",
        namespace: "quick-replies",
        handler,
      }),
    ).toEqual({ ok: true });

    const dispatch = () =>
      dispatchPluginInteractiveHandler({
        channel: "discord",
        data: "quick-replies:continue",
        dedupeId: "discord-submit-text",
        invoke: ({ registration }) => registration.handler({}),
        afterInvoke,
      });

    await expect(dispatch()).resolves.toEqual({
      matched: true,
      handled: true,
      duplicate: false,
      result,
    });
    await expect(dispatch()).resolves.toEqual({
      matched: true,
      handled: true,
      duplicate: true,
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(afterInvoke).toHaveBeenCalledOnce();
    expect(afterInvoke).toHaveBeenCalledWith(result);
  });
});
