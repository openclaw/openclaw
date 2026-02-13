/**
 * Test: message_sending & message_sent hook wiring
 *
 * Tests the hook runner methods directly since outbound delivery is deeply integrated.
 */
import { describe, expect, it, vi } from "vitest";
import type { PluginRegistry } from "./registry.js";
import { createHookRunner } from "./hooks.js";

function createMockRegistry(
  hooks: Array<{ hookName: string; handler: (...args: unknown[]) => unknown }>,
): PluginRegistry {
  return {
    hooks: hooks as never[],
    typedHooks: hooks.map((h) => ({
      pluginId: "test-plugin",
      hookName: h.hookName,
      handler: h.handler,
      priority: 0,
      source: "test",
    })),
    tools: [],
    httpHandlers: [],
    httpRoutes: [],
    channelRegistrations: [],
    gatewayHandlers: {},
    cliRegistrars: [],
    services: [],
    providers: [],
    commands: [],
  } as unknown as PluginRegistry;
}

describe("message_sending hook runner", () => {
  it("runMessageSending invokes registered hooks and returns modified content", async () => {
    const handler = vi.fn().mockReturnValue({ content: "modified content" });
    const registry = createMockRegistry([{ hookName: "message_sending", handler }]);
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
    const registry = createMockRegistry([{ hookName: "message_sending", handler }]);
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
    const registry = createMockRegistry([{ hookName: "message_sent", handler }]);
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
    const registry = createMockRegistry([{ hookName: "message_sent", handler }]);
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
