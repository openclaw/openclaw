import { afterEach, expect, it } from "vitest";
import { registryContainsRuntimePluginIds } from "./active-runtime-registry.js";
import { projectBlockedHookDiagnostics } from "./blocked-hook-diagnostics.js";
import { loadOpenClawPlugins } from "./loader.js";
import {
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRegistry } from "./registry-types.js";
import { disposePluginRegistryInstances } from "./runtime.js";

const registries: PluginRegistry[] = [];
afterEach(async () => {
  for (const registry of registries.splice(0).toReversed()) {
    await disposePluginRegistryInstances(registry);
  }
  resetPluginLoaderTestStateForTest();
});

it.each([
  { hooks: {}, reasons: ["conversation-access-missing", "conversation-access-missing"] },
  {
    hooks: { allowConversationAccess: false },
    reasons: ["conversation-access-denied", "conversation-access-denied"],
  },
  {
    hooks: { allowConversationAccess: true, allowPromptInjection: false },
    reasons: ["prompt-injection-denied"],
  },
  { hooks: { allowConversationAccess: true }, reasons: [] },
])("records actual refusals without changing grant defaults: $hooks", ({ hooks, reasons }) => {
  useNoBundledPlugins();
  const plugin = writePlugin({
    id: "permission-proof",
    registration:
      'api.on("before_prompt_build", () => {}); api.on("before_agent_reply", () => {}); api.on("gateway_start", () => {});',
  });
  const config = {
    plugins: {
      allow: [plugin.id],
      load: { paths: [plugin.file] },
      slots: { memory: "none" },
      entries: { [plugin.id]: { enabled: true, hooks } },
    },
  };
  const initial = loadOpenClawPlugins({ config, cache: false, activate: false });
  registries.push(initial);
  expect(initial.blockedHooks.map((entry) => entry.reason)).toEqual(reasons);
  expect(initial.blockedHooks.every((entry) => entry.severity === "warn")).toBe(true);
  expect(initial.typedHooks.map((entry) => entry.hookName)).toContain("gateway_start");
  for (const blocked of initial.blockedHooks) {
    expect(initial.typedHooks.some((entry) => entry.hookName === blocked.hookName)).toBe(false);
  }
  const retained = loadOpenClawPlugins({
    config,
    cache: false,
    activate: false,
    previousRegistry: initial,
  });
  registries.push(retained);
  expect(retained.plugins[0]).toBe(initial.plugins[0]);
  expect(retained.blockedHooks).toEqual(initial.blockedHooks);
  const granted = loadOpenClawPlugins({
    config: {
      plugins: {
        ...config.plugins,
        entries: { [plugin.id]: { enabled: true, hooks: { allowConversationAccess: true } } },
      },
    },
    cache: false,
    activate: false,
    previousRegistry: retained,
  });
  registries.push(granted);
  expect(granted.blockedHooks).toEqual([]);
  expect(initial.blockedHooks.map((entry) => entry.reason)).toEqual(reasons);
  const projected = projectBlockedHookDiagnostics(initial);
  expect(projected).toHaveLength(reasons.length);
  expect(projected.every((entry) => !("source" in entry) && entry.pluginId === plugin.id)).toBe(
    true,
  );
  const refusedOnly = createEmptyPluginRegistry();
  refusedOnly.blockedHooks.push(...initial.blockedHooks);
  expect(registryContainsRuntimePluginIds(refusedOnly, [plugin.id])).toBe(false);
});
