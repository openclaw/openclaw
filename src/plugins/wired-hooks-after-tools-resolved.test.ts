import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

describe("after_tools_resolved hook runner", () => {
  it("runAfterToolsResolved invokes registered hooks", async () => {
    const handler = vi.fn();
    const registry = createMockPluginRegistry([{ hookName: "after_tools_resolved", handler }]);
    const runner = createHookRunner(registry);

    await runner.runAfterToolsResolved(
      {
        tools: [
          {
            name: "exec",
            parameters: {
              type: "object",
              properties: {
                command: { type: "string" },
              },
              required: ["command"],
            },
          },
        ],
        provider: "openai",
        model: "gpt-5",
      },
      {
        agentId: "main",
        sessionId: "session-1",
      },
    );

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5",
      }),
      expect.objectContaining({
        agentId: "main",
        sessionId: "session-1",
      }),
    );
  });

  it("hasHooks reports after_tools_resolved registrations", () => {
    const registry = createMockPluginRegistry([
      { hookName: "after_tools_resolved", handler: vi.fn() },
    ]);
    const runner = createHookRunner(registry);

    expect(runner.hasHooks("after_tools_resolved")).toBe(true);
  });
});
