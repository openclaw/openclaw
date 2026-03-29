import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { addTestHook, createMockPluginRegistry } from "./hooks.test-helpers.js";

describe("plugin_updated hook runner", () => {
  it("runPluginUpdated invokes registered plugin_updated hooks", async () => {
    const handler = vi.fn();
    const registry = createMockPluginRegistry([{ hookName: "plugin_updated", handler }]);
    const runner = createHookRunner(registry);

    await runner.runPluginUpdated(
      {
        pluginId: "demo",
        requestedPluginId: "demo",
        source: "npm",
        spec: "@openclaw/demo@1.2.3",
        previousVersion: "1.2.2",
        nextVersion: "1.2.3",
        installPath: "/tmp/demo",
      },
      { trigger: "plugins_update" },
    );

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "demo",
        nextVersion: "1.2.3",
      }),
      { trigger: "plugins_update" },
    );
  });

  it("runPluginUpdatedForPlugin only invokes hooks for the targeted plugin id", async () => {
    const target = vi.fn();
    const other = vi.fn();
    const registry = createMockPluginRegistry([]);
    addTestHook({ registry, pluginId: "target", hookName: "plugin_updated", handler: target });
    addTestHook({ registry, pluginId: "other", hookName: "plugin_updated", handler: other });
    const runner = createHookRunner(registry);

    const handled = await runner.runPluginUpdatedForPlugin(
      "target",
      {
        pluginId: "target",
        requestedPluginId: "target",
        source: "npm",
        installPath: "/tmp/target",
      },
      { trigger: "plugins_update" },
    );

    expect(handled).toBe(true);
    expect(target).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
  });
});
