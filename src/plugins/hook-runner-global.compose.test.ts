import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getGlobalHookRunnerRegistry } from "./hook-runner-global-state.js";
import {
  getGlobalHookRunner,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "./hook-runner-global.js";
import { addTestHook, createMockPluginRegistry } from "./hooks.test-fixtures.js";
import type { PluginRegistry } from "./registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import { createPluginRecord } from "./status.test-helpers.js";

const context = {
  agentId: "test-agent",
  sessionKey: "test-session",
  toolCallId: "test-call",
  toolName: "read",
};
const runner = () => expectDefined(getGlobalHookRunner(), "global hook runner");
const runTool = () => runner().runBeforeToolCall({ toolName: "read", params: {} }, context);
const policyIds = () =>
  getGlobalHookRunnerRegistry()?.trustedToolPolicies?.map(({ policy }) => policy.id);

function toolRegistry(pluginId: string, withPolicy = false) {
  const hook = vi.fn();
  const registry = createMockPluginRegistry([
    { hookName: "before_tool_call", handler: hook, pluginId },
  ]);
  if (withPolicy) {
    registry.trustedToolPolicies = [
      {
        pluginId,
        pluginName: pluginId,
        source: "test",
        policy: { id: `${pluginId}-policy`, description: pluginId, evaluate: () => undefined },
      },
    ];
  }
  return { hook, registry };
}
function initializeRoot(root: PluginRegistry, initial = root) {
  setActivePluginRegistry(root);
  initializeGlobalHookRunner(initial);
}
afterEach(() => {
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
});

describe("global hook runner registry selection", () => {
  it.each(["add", "replace", "failed"] as const)(
    "overlays request contributions (%s) and restores the process root",
    async (mode) => {
      const additive = mode === "add";
      const { hook: rootHook, registry: root } = toolRegistry(
        additive ? "root" : "shared",
        mode !== "replace",
      );
      const { hook: scopedHook, registry: scoped } = toolRegistry(
        additive ? "scoped" : "shared",
        additive,
      );
      if (mode === "failed") {
        scoped.hooks = [];
        scoped.typedHooks = [];
        scoped.plugins = [
          createPluginRecord({ id: "shared", status: "error", error: "load failed" }),
        ];
      }
      initializeRoot(root);
      await withPluginRuntimeRegistryScope(scoped, async () => {
        await runTool();
        expect(policyIds()).toEqual(
          additive ? ["root-policy", "scoped-policy"] : mode === "failed" ? ["shared-policy"] : [],
        );
      });
      expect(scopedHook).toHaveBeenCalledTimes(mode === "failed" ? 0 : 1);
      expect(rootHook).toHaveBeenCalledTimes(mode === "replace" ? 0 : 1);
      await runTool();
      expect(rootHook).toHaveBeenCalledTimes(mode === "replace" ? 1 : 2);
      expect(policyIds()).toEqual(
        mode === "replace" ? [] : [additive ? "root-policy" : "shared-policy"],
      );
    },
  );

  it("overlays an explicitly initialized SDK registry on the process root", async () => {
    const { hook: rootToolHook, registry: root } = toolRegistry("shared", true);
    const rootWriteHook = vi.fn();
    addTestHook({
      registry: root,
      hookName: "before_message_write",
      handler: rootWriteHook,
      pluginId: "shared",
    });
    const sdkWriteHook = vi.fn(() => ({
      message: { role: "user", content: "sdk redaction", timestamp: 2 },
    }));
    const sdk = createMockPluginRegistry([
      { hookName: "before_message_write", handler: sdkWriteHook, pluginId: "shared" },
    ]);
    initializeRoot(root, sdk);
    expect(
      runner().runBeforeMessageWrite(
        { message: { role: "user", content: "private", timestamp: 1 } },
        context,
      ),
    ).toEqual({ message: { role: "user", content: "sdk redaction", timestamp: 2 } });
    expect(sdkWriteHook).toHaveBeenCalledOnce();
    expect(rootWriteHook).not.toHaveBeenCalled();
    await runTool();
    expect(rootToolHook).toHaveBeenCalledOnce();
    expect(policyIds()).toEqual(["shared-policy"]);
  });

  it("sees hooks added after initialization", () => {
    const registry = createMockPluginRegistry([
      { hookName: "message_received", handler: vi.fn(), pluginId: "plugin" },
    ]);
    initializeRoot(registry);
    expect(runner().hasHooks("message_sent")).toBe(false);
    addTestHook({ registry, pluginId: "plugin", hookName: "message_sent", handler: vi.fn() });
    expect(runner().hasHooks("message_sent")).toBe(true);
  });
});
