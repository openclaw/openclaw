/**
 * Test: message_ingest hook wiring
 *
 * Verifies:
 * - message_ingest fires and is isolated from message_received
 * - message_received does NOT fire on the ingest path
 * - hasHooks("message_ingest") correctly reflects registration state
 */
import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

describe("message_ingest hook runner", () => {
  it("runMessageIngest invokes registered message_ingest hooks", async () => {
    const handler = vi.fn();
    const registry = createMockPluginRegistry([{ hookName: "message_ingest", handler }]);
    const runner = createHookRunner(registry);

    await runner.runMessageIngest(
      { from: "telegram:group:-100123", content: "hello world" },
      { channelId: "telegram", accountId: "main", conversationId: "-100123" },
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      { from: "telegram:group:-100123", content: "hello world" },
      { channelId: "telegram", accountId: "main", conversationId: "-100123" },
    );
  });

  it("message_received hook does NOT fire when runMessageIngest is called", async () => {
    const ingestHandler = vi.fn();
    const receivedHandler = vi.fn();
    const registry = createMockPluginRegistry([
      { hookName: "message_ingest", handler: ingestHandler },
      { hookName: "message_received", handler: receivedHandler },
    ]);
    const runner = createHookRunner(registry);

    await runner.runMessageIngest(
      { from: "telegram:group:-100123", content: "silent message" },
      { channelId: "telegram" },
    );

    expect(ingestHandler).toHaveBeenCalledTimes(1);
    expect(receivedHandler).not.toHaveBeenCalled();
  });

  it("message_ingest hook does NOT fire when runMessageReceived is called", async () => {
    const ingestHandler = vi.fn();
    const receivedHandler = vi.fn();
    const registry = createMockPluginRegistry([
      { hookName: "message_ingest", handler: ingestHandler },
      { hookName: "message_received", handler: receivedHandler },
    ]);
    const runner = createHookRunner(registry);

    await runner.runMessageReceived(
      { from: "telegram:group:-100123", content: "mentioned message" },
      { channelId: "telegram" },
    );

    expect(receivedHandler).toHaveBeenCalledTimes(1);
    expect(ingestHandler).not.toHaveBeenCalled();
  });

  it("hasHooks returns false when no message_ingest handlers registered", () => {
    const registry = createMockPluginRegistry([{ hookName: "message_received", handler: vi.fn() }]);
    const runner = createHookRunner(registry);
    expect(runner.hasHooks("message_ingest")).toBe(false);
  });

  it("hasHooks returns true when a message_ingest handler is registered", () => {
    const registry = createMockPluginRegistry([{ hookName: "message_ingest", handler: vi.fn() }]);
    const runner = createHookRunner(registry);
    expect(runner.hasHooks("message_ingest")).toBe(true);
  });

  it("runMessageIngest is a no-op when no handlers are registered", async () => {
    const registry = createMockPluginRegistry([]);
    const runner = createHookRunner(registry);
    await expect(
      runner.runMessageIngest(
        { from: "telegram:group:-100123", content: "test" },
        { channelId: "telegram" },
      ),
    ).resolves.toBeUndefined();
  });
});
