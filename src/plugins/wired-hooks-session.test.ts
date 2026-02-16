/**
 * Test: session_start & session_end hook wiring
 *
 * Tests the hook runner methods directly since session init is deeply integrated.
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

describe("session hook runner methods", () => {
  it("runSessionStart invokes registered session_start hooks", async () => {
    const handler = vi.fn();
    const registry = createMockRegistry([{ hookName: "session_start", handler }]);
    const runner = createHookRunner(registry);

    await runner.runSessionStart(
      { sessionId: "abc-123", resumedFrom: "old-session" },
      { sessionId: "abc-123", agentId: "main" },
    );

    expect(handler).toHaveBeenCalledWith(
      { sessionId: "abc-123", resumedFrom: "old-session" },
      { sessionId: "abc-123", agentId: "main" },
    );
  });

  it("runSessionEnd invokes registered session_end hooks", async () => {
    const handler = vi.fn();
    const registry = createMockRegistry([{ hookName: "session_end", handler }]);
    const runner = createHookRunner(registry);

    await runner.runSessionEnd(
      { sessionId: "abc-123", messageCount: 42 },
      { sessionId: "abc-123", agentId: "main" },
    );

    expect(handler).toHaveBeenCalledWith(
      { sessionId: "abc-123", messageCount: 42 },
      { sessionId: "abc-123", agentId: "main" },
    );
  });

  it("hasHooks returns true for registered session hooks", () => {
    const registry = createMockRegistry([{ hookName: "session_start", handler: vi.fn() }]);
    const runner = createHookRunner(registry);

    expect(runner.hasHooks("session_start")).toBe(true);
    expect(runner.hasHooks("session_end")).toBe(false);
  });
});
