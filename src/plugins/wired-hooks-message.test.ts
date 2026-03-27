/**
 * Test: message_sending & message_sent hook wiring
 *
 * Tests the hook runner methods directly since outbound delivery is deeply integrated.
 */
import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

describe("message_sending hook runner", () => {
  const demoChannelCtx = { channelId: "demo-channel" };

  it("runMessageSending invokes registered hooks and returns modified content", async () => {
    const handler = vi.fn().mockReturnValue({ content: "modified content" });
    const registry = createMockPluginRegistry([{ hookName: "message_sending", handler }]);
    const runner = createHookRunner(registry);

    const result = await runner.runMessageSending(
      { to: "user-123", content: "original content" },
      demoChannelCtx,
    );

    expect(handler).toHaveBeenCalledWith(
      { to: "user-123", content: "original content" },
      demoChannelCtx,
    );
    expect(result?.content).toBe("modified content");
  });

  it("runMessageSending can cancel message delivery", async () => {
    const handler = vi.fn().mockReturnValue({ cancel: true });
    const registry = createMockPluginRegistry([{ hookName: "message_sending", handler }]);
    const runner = createHookRunner(registry);

    const result = await runner.runMessageSending(
      { to: "user-123", content: "blocked" },
      demoChannelCtx,
    );

    expect(result?.cancel).toBe(true);
  });
});

describe("message_sent hook runner", () => {
  const demoChannelCtx = { channelId: "demo-channel" };

  it("runMessageSent invokes registered hooks with success=true", async () => {
    const handler = vi.fn();
    const registry = createMockPluginRegistry([{ hookName: "message_sent", handler }]);
    const runner = createHookRunner(registry);

    await runner.runMessageSent(
      { to: "user-123", content: "hello", success: true },
      demoChannelCtx,
    );

    expect(handler).toHaveBeenCalledWith(
      { to: "user-123", content: "hello", success: true },
      demoChannelCtx,
    );
  });

  it("runMessageSent invokes registered hooks with error on failure", async () => {
    const handler = vi.fn();
    const registry = createMockPluginRegistry([{ hookName: "message_sent", handler }]);
    const runner = createHookRunner(registry);

    await runner.runMessageSent(
      { to: "user-123", content: "hello", success: false, error: "timeout" },
      demoChannelCtx,
    );

    expect(handler).toHaveBeenCalledWith(
      { to: "user-123", content: "hello", success: false, error: "timeout" },
      demoChannelCtx,
    );
  });
});
