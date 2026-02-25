/**
 * Test: message_sending & message_sent hook wiring
 *
 * Tests the hook runner methods directly since outbound delivery is deeply integrated.
 */
import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

describe("message_observed hook runner", () => {
  it("returns { handled: true } when handler signals handled", async () => {
    const handler = vi.fn().mockReturnValue({ handled: true });
    const registry = createMockPluginRegistry([{ hookName: "message_observed", handler }]);
    const runner = createHookRunner(registry);

    const result = await runner.runMessageObserved(
      { from: "user-1", content: "hello", fromMe: false },
      { channelId: "whatsapp" },
    );

    expect(handler).toHaveBeenCalledWith(
      { from: "user-1", content: "hello", fromMe: false },
      { channelId: "whatsapp" },
    );
    expect(result?.handled).toBe(true);
  });

  it("returns undefined for void-returning handlers", async () => {
    const handler = vi.fn(); // returns undefined
    const registry = createMockPluginRegistry([{ hookName: "message_observed", handler }]);
    const runner = createHookRunner(registry);

    const result = await runner.runMessageObserved(
      { from: "user-1", content: "hello", fromMe: false },
      { channelId: "whatsapp" },
    );

    expect(handler).toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("handler receives fromMe field correctly", async () => {
    const handler = vi.fn().mockReturnValue({ handled: true });
    const registry = createMockPluginRegistry([{ hookName: "message_observed", handler }]);
    const runner = createHookRunner(registry);

    await runner.runMessageObserved(
      { from: "+15555550123", content: "outbound msg", fromMe: true },
      { channelId: "whatsapp" },
    );

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ fromMe: true }),
      expect.anything(),
    );
  });
});

describe("message_sending hook runner", () => {
  it("runMessageSending invokes registered hooks and returns modified content", async () => {
    const handler = vi.fn().mockReturnValue({ content: "modified content" });
    const registry = createMockPluginRegistry([{ hookName: "message_sending", handler }]);
    const runner = createHookRunner(registry);

    const result = await runner.runMessageSending(
      { to: "user-123", content: "original content" },
      { channelId: "telegram" },
    );

    expect(handler).toHaveBeenCalledWith(
      { to: "user-123", content: "original content" },
      { channelId: "telegram" },
    );
    expect(result?.content).toBe("modified content");
  });

  it("runMessageSending can cancel message delivery", async () => {
    const handler = vi.fn().mockReturnValue({ cancel: true });
    const registry = createMockPluginRegistry([{ hookName: "message_sending", handler }]);
    const runner = createHookRunner(registry);

    const result = await runner.runMessageSending(
      { to: "user-123", content: "blocked" },
      { channelId: "telegram" },
    );

    expect(result?.cancel).toBe(true);
  });
});

describe("message_sent hook runner", () => {
  it("runMessageSent invokes registered hooks with success=true", async () => {
    const handler = vi.fn();
    const registry = createMockPluginRegistry([{ hookName: "message_sent", handler }]);
    const runner = createHookRunner(registry);

    await runner.runMessageSent(
      { to: "user-123", content: "hello", success: true },
      { channelId: "telegram" },
    );

    expect(handler).toHaveBeenCalledWith(
      { to: "user-123", content: "hello", success: true },
      { channelId: "telegram" },
    );
  });

  it("runMessageSent invokes registered hooks with error on failure", async () => {
    const handler = vi.fn();
    const registry = createMockPluginRegistry([{ hookName: "message_sent", handler }]);
    const runner = createHookRunner(registry);

    await runner.runMessageSent(
      { to: "user-123", content: "hello", success: false, error: "timeout" },
      { channelId: "telegram" },
    );

    expect(handler).toHaveBeenCalledWith(
      { to: "user-123", content: "hello", success: false, error: "timeout" },
      { channelId: "telegram" },
    );
  });
});
