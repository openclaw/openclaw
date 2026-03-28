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
  it.each([
    {
      name: "runMessageSending invokes registered hooks and returns modified content",
      event: { to: "user-123", content: "original content" },
      hookResult: { content: "modified content" },
      expected: { content: "modified content" },
    },
    {
      name: "runMessageSending can cancel message delivery",
      event: { to: "user-123", content: "blocked" },
      hookResult: { cancel: true },
      expected: { cancel: true },
    },
  ] as const)("$name", async ({ event, hookResult, expected }) => {
    const handler = vi.fn().mockReturnValue(hookResult);
    const registry = createMockPluginRegistry([{ hookName: "message_sending", handler }]);
    const runner = createHookRunner(registry);

    const result = await runner.runMessageSending(event, demoChannelCtx);

    expect(handler).toHaveBeenCalledWith(event, demoChannelCtx);
    expect(result).toEqual(expect.objectContaining(expected));
  });
});

describe("message_sent hook runner", () => {
  const demoChannelCtx = { channelId: "demo-channel" };

  it.each([
    {
      name: "runMessageSent invokes registered hooks with success=true",
      event: { to: "user-123", content: "hello", success: true },
    },
    {
      name: "runMessageSent invokes registered hooks with error on failure",
      event: { to: "user-123", content: "hello", success: false, error: "timeout" },
    },
  ] as const)("$name", async ({ event }) => {
    const handler = vi.fn();
    const registry = createMockPluginRegistry([{ hookName: "message_sent", handler }]);
    const runner = createHookRunner(registry);

    await runner.runMessageSent(event, demoChannelCtx);

    expect(handler).toHaveBeenCalledWith(event, demoChannelCtx);
  });
});
