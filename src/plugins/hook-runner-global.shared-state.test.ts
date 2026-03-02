import { afterEach, describe, expect, it, vi } from "vitest";
import type { TypedPluginHookRegistration } from "./registry.js";

describe("hook-runner-global shared state", () => {
  afterEach(async () => {
    const mod = await import("./hook-runner-global.js");
    mod.resetGlobalHookRunner();
    vi.resetModules();
  });

  it("preserves initialized hook runner across module reloads", async () => {
    const mod1 = await import("./hook-runner-global.js");
    const { createEmptyPluginRegistry } = await import("./registry.js");

    const registry = createEmptyPluginRegistry();
    const hook: TypedPluginHookRegistration = {
      pluginId: "test.plugin",
      hookName: "message_sending",
      handler: async () => undefined,
      source: "test",
    };
    registry.typedHooks.push(hook);

    mod1.initializeGlobalHookRunner(registry);
    expect(mod1.getGlobalHookRunner()?.hasHooks("message_sending")).toBe(true);

    vi.resetModules();

    const mod2 = await import("./hook-runner-global.js");
    expect(mod2.getGlobalHookRunner()?.hasHooks("message_sending")).toBe(true);
  });
});
