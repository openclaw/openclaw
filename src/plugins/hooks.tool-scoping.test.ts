import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { addTestHooks } from "./hooks.test-helpers.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";

const stubCtx = {
  toolName: "exec",
  agentId: "main",
  sessionKey: "agent:main:main",
};

describe("hook runner tool scoping", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  it("hasHooks only reports before_tool_call hooks that match the requested tool", () => {
    addTestHooks(registry, [
      {
        pluginId: "exec-only",
        hookName: "before_tool_call",
        handler: vi.fn(),
        toolNames: ["exec"],
      },
      {
        pluginId: "browser-only",
        hookName: "before_tool_call",
        handler: vi.fn(),
        toolNames: ["browser"],
      },
    ]);

    const runner = createHookRunner(registry);

    expect(runner.hasHooks("before_tool_call")).toBe(true);
    expect(runner.hasHooks("before_tool_call", "exec")).toBe(true);
    expect(runner.hasHooks("before_tool_call", "browser")).toBe(true);
    expect(runner.hasHooks("before_tool_call", "message")).toBe(false);
  });

  it("runBeforeToolCall only invokes hooks scoped to the matching tool plus global hooks", async () => {
    const execOnly = vi.fn(async () => ({ params: { fromExecOnly: true } }));
    const browserOnly = vi.fn(async () => ({ params: { fromBrowserOnly: true } }));
    const globalHook = vi.fn(async () => ({ params: { fromGlobal: true } }));

    addTestHooks(registry, [
      {
        pluginId: "exec-only",
        hookName: "before_tool_call",
        handler: execOnly,
        toolNames: ["exec"],
      },
      {
        pluginId: "browser-only",
        hookName: "before_tool_call",
        handler: browserOnly,
        toolNames: ["browser"],
      },
      {
        pluginId: "global",
        hookName: "before_tool_call",
        handler: globalHook,
      },
    ]);

    const runner = createHookRunner(registry);
    const result = await runner.runBeforeToolCall(
      {
        toolName: "exec",
        params: {},
      },
      stubCtx,
    );

    expect(execOnly).toHaveBeenCalledTimes(1);
    expect(browserOnly).not.toHaveBeenCalled();
    expect(globalHook).toHaveBeenCalledTimes(1);
    expect(result?.params).toEqual({ fromGlobal: true });
  });
});
