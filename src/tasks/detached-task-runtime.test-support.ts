import { createPluginRecord } from "../plugins/loader-records.js";
import type { PluginRecord, PluginRegistry } from "../plugins/registry-types.js";
import { requireActivePluginRegistry } from "../plugins/runtime.js";
import type { DetachedTaskLifecycleRuntime } from "./detached-task-runtime-contract.js";

const fixtureRecords = new WeakMap<PluginRegistry, Set<PluginRecord>>();

export function setDetachedTaskLifecycleRuntime(
  runtime: DetachedTaskLifecycleRuntime,
  pluginId = "__test__",
): void {
  const registry = requireActivePluginRegistry();
  if (!registry.plugins.some((record) => record.id === pluginId)) {
    const record = createPluginRecord({
      id: pluginId,
      source: "/plugins/detached-task-runtime-fixture/index.js",
      origin: "config",
      enabled: true,
      configSchema: true,
    });
    registry.plugins.push(record);
    const owned = fixtureRecords.get(registry) ?? new Set<PluginRecord>();
    owned.add(record);
    fixtureRecords.set(registry, owned);
  }
  const registrations = registry.detachedTaskRuntimes;
  registrations.splice(0, registrations.length, { pluginId, runtime });
}

export function resetDetachedTaskLifecycleRuntimeForTests(): void {
  const registry = requireActivePluginRegistry();
  registry.detachedTaskRuntimes.length = 0;
  for (const record of fixtureRecords.get(registry) ?? []) {
    const index = registry.plugins.indexOf(record);
    if (index !== -1) {
      registry.plugins.splice(index, 1);
    }
  }
  fixtureRecords.delete(registry);
}
