/**
 * Test: session_start & session_end hook wiring
 *
 * Tests the hook runner methods directly since session init is deeply integrated.
 */
import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

describe("session hook runner methods", () => {
  const sessionCtx = { sessionId: "abc-123", sessionKey: "agent:main:abc", agentId: "main" };

  it.each([
    {
      name: "runSessionStart invokes registered session_start hooks",
      hookName: "session_start" as const,
      methodName: "runSessionStart" as const,
      event: { sessionId: "abc-123", sessionKey: "agent:main:abc", resumedFrom: "old-session" },
    },
    {
      name: "runSessionEnd invokes registered session_end hooks",
      hookName: "session_end" as const,
      methodName: "runSessionEnd" as const,
      event: { sessionId: "abc-123", sessionKey: "agent:main:abc", messageCount: 42 },
    },
  ] as const)("$name", async ({ hookName, methodName, event }) => {
    const handler = vi.fn();
    const registry = createMockPluginRegistry([{ hookName, handler }]);
    const runner = createHookRunner(registry);

    if (methodName === "runSessionStart") {
      await runner.runSessionStart(event, sessionCtx);
    } else {
      await runner.runSessionEnd(event, sessionCtx);
    }

    expect(handler).toHaveBeenCalledWith(event, sessionCtx);
  });

  it("hasHooks returns true for registered session hooks", () => {
    const registry = createMockPluginRegistry([{ hookName: "session_start", handler: vi.fn() }]);
    const runner = createHookRunner(registry);

    expect(runner.hasHooks("session_start")).toBe(true);
    expect(runner.hasHooks("session_end")).toBe(false);
  });
});
