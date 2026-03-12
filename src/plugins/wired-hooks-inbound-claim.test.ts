import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

describe("inbound_claim hook runner", () => {
  it("stops at the first handler that claims the event", async () => {
    const first = vi.fn().mockResolvedValue({ handled: true });
    const second = vi.fn().mockResolvedValue({ handled: true });
    const registry = createMockPluginRegistry([
      { hookName: "inbound_claim", handler: first },
      { hookName: "inbound_claim", handler: second },
    ]);
    const runner = createHookRunner(registry);

    const result = await runner.runInboundClaim(
      {
        content: "who are you",
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:77",
        isGroup: true,
      },
      {
        channelId: "telegram",
        accountId: "default",
        conversationId: "123:topic:77",
      },
    );

    expect(result).toEqual({ handled: true });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("continues to the next handler when a higher-priority handler throws", async () => {
    const logger = {
      warn: vi.fn(),
      error: vi.fn(),
    };
    const failing = vi.fn().mockRejectedValue(new Error("boom"));
    const succeeding = vi.fn().mockResolvedValue({ handled: true });
    const registry = createMockPluginRegistry([
      { hookName: "inbound_claim", handler: failing },
      { hookName: "inbound_claim", handler: succeeding },
    ]);
    const runner = createHookRunner(registry, { logger });

    const result = await runner.runInboundClaim(
      {
        content: "hi",
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
        isGroup: false,
      },
      {
        channelId: "telegram",
        accountId: "default",
        conversationId: "123",
      },
    );

    expect(result).toEqual({ handled: true });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("inbound_claim handler from test-plugin failed: Error: boom"),
    );
    expect(succeeding).toHaveBeenCalledTimes(1);
  });
});
