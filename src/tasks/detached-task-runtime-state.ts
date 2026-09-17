import {
  capturePluginRegistryLifecycleEpoch,
  isPluginRecordActive,
  isPluginRegistryLifecycleEpochActive,
} from "../plugins/registry-lifecycle.js";
import { getPluginRegistryForContext, requireActivePluginRegistry } from "../plugins/runtime.js";
import type { DetachedTaskLifecycleRuntime } from "./detached-task-runtime-contract.js";

export function getRegisteredDetachedTaskLifecycleRuntime():
  | DetachedTaskLifecycleRuntime
  | undefined {
  return requireActivePluginRegistry().detachedTaskRuntimes[0]?.runtime;
}

/** An awaited creation retains its context-selected registration and activation. */
export function captureDetachedTaskRuntimeOwner(): {
  runtime: DetachedTaskLifecycleRuntime | undefined;
  assertCurrent: () => void;
} {
  const registry = requireActivePluginRegistry();
  const registration = registry.detachedTaskRuntimes[0];
  const runtime = registration?.runtime;
  const record = registration
    ? registry.plugins.find((candidate) => candidate.id === registration.pluginId)
    : undefined;
  const epoch = capturePluginRegistryLifecycleEpoch(registry);
  return {
    runtime,
    assertCurrent() {
      if (
        !epoch ||
        !isPluginRegistryLifecycleEpochActive(registry, epoch) ||
        getPluginRegistryForContext() !== registry ||
        registry.detachedTaskRuntimes[0] !== registration ||
        registration?.runtime !== runtime ||
        (registration && (!record || !isPluginRecordActive(registry, record)))
      ) {
        throw new Error("Detached task runtime owner changed before task creation settled.");
      }
    },
  };
}
