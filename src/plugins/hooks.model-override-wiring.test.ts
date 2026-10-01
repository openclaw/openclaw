import { expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { addStaticTestHooks, TEST_PLUGIN_AGENT_CTX } from "./hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "./registry.js";

it("keeps the highest-priority model override after a broken plugin", async () => {
  const registry = createEmptyPluginRegistry();
  const broken = vi.fn(() => {
    throw new Error("plugin crashed");
  });
  addStaticTestHooks(registry, {
    hookName: "before_model_resolve",
    hooks: [
      {
        pluginId: "low",
        result: { modelOverride: "low-model", providerOverride: "low-provider" },
      },
      {
        pluginId: "broken",
        priority: 100,
        result: {},
        handler: broken,
      },
      {
        pluginId: "high",
        priority: 10,
        result: { modelOverride: "high-model", providerOverride: "high-provider" },
      },
    ],
  });
  await expect(
    createHookRunner(registry).runBeforeModelResolve({ prompt: "test" }, TEST_PLUGIN_AGENT_CTX),
  ).resolves.toEqual({ modelOverride: "high-model", providerOverride: "high-provider" });
  expect(broken).toHaveBeenCalledOnce();
});
