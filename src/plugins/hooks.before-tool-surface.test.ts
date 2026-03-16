import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

describe("before_tool_surface hook", () => {
  it("filters tools via hook handler", async () => {
    const handler = vi.fn().mockReturnValue({
      tools: [{ name: "read", description: "read", parameters: {} }],
    });
    const registry = createMockPluginRegistry([{ hookName: "before_tool_surface", handler }]);
    const runner = createHookRunner(registry);

    const event = {
      tools: [
        { name: "read", description: "read", parameters: {} },
        { name: "write", description: "write", parameters: {} },
        { name: "message", description: "message", parameters: {} },
      ],
    };
    const ctx = {
      agentId: "test",
      sessionKey: "test-sk",
      sessionId: "test-sid",
    };

    const result = await runner.runBeforeToolSurface(event, ctx);

    expect(handler).toHaveBeenCalledWith(event, ctx);
    expect(result?.tools).toHaveLength(1);
    expect(result?.tools?.[0].name).toBe("read");
  });

  it("returns undefined when no hooks registered", async () => {
    const registry = createMockPluginRegistry([]);
    const runner = createHookRunner(registry);

    const result = await runner.runBeforeToolSurface(
      { tools: [{ name: "read", description: "read", parameters: {} }] },
      { agentId: "test" },
    );

    expect(result).toBeUndefined();
  });

  it("merges multiple handlers — last defined tools wins", async () => {
    const handler1 = vi.fn().mockReturnValue({
      tools: [{ name: "a", description: "a", parameters: {} }],
    });
    const handler2 = vi.fn().mockReturnValue({
      tools: [{ name: "b", description: "b", parameters: {} }],
    });
    const registry = createMockPluginRegistry([
      { hookName: "before_tool_surface", handler: handler1 },
      { hookName: "before_tool_surface", handler: handler2 },
    ]);
    const runner = createHookRunner(registry);

    const result = await runner.runBeforeToolSurface({ tools: [] }, { agentId: "test" });

    expect(result?.tools?.[0].name).toBe("b");
  });
});
