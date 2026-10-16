import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "../../plugins/hooks.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-helpers.js";
import { applyMessageSendingHook } from "./deliver-hooks.js";

describe("message-sending failure ownership", () => {
  const payload = { text: "Original reply" };
  const params = {
    enabled: true,
    payload,
    payloadSummary: { text: payload.text, mediaUrls: [] },
    to: "test-recipient",
    channel: "test-channel",
  };

  it("keeps handler failure logging and fail-open behavior with the hook runner", async () => {
    const error = new Error("handler failed");
    const logger = { error: vi.fn(), warn: vi.fn() };
    const hookRunner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "message_sending",
          handler: () => {
            throw error;
          },
        },
      ]),
      { logger },
    );

    await expect(applyMessageSendingHook({ ...params, hookRunner })).resolves.toEqual({
      cancelled: false,
      changed: false,
      payload,
    });
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("message_sending handler from test-plugin failed: handler failed"),
    );
  });

  it("does not turn a hook framework failure into an accepted original payload", async () => {
    const error = new Error("hook registry unavailable");
    const registry = createMockPluginRegistry([]);
    Object.defineProperty(registry, "typedHooks", {
      get() {
        throw error;
      },
    });
    const hookRunner = createHookRunner(registry);

    await expect(applyMessageSendingHook({ ...params, hookRunner })).rejects.toBe(error);
  });

  it("preserves an injected runner's explicit fail-closed handler policy", async () => {
    const hookRunner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "message_sending",
          handler: () => {
            throw new Error("handler refused");
          },
        },
      ]),
      { failurePolicyByHook: { message_sending: "fail-closed" } },
    );

    await expect(applyMessageSendingHook({ ...params, hookRunner })).rejects.toThrow(
      "handler refused",
    );
  });
});
