import {
  capturePluginLifecycleAuthority,
  capturePluginRegistryLifecycleEpoch,
  getPluginRecordRegistry,
  isPluginRegistryLifecycleEpochActive,
} from "../plugins/registry-lifecycle.js";
import { getPluginRegistryForContext, requireActivePluginRegistry } from "../plugins/runtime.js";
import {
  DetachedTaskRuntimeOwnerRetiredError,
  type DetachedTaskLifecycleRuntime,
} from "./detached-task-runtime-contract.js";

export function getRegisteredDetachedTaskLifecycleRuntime():
  | DetachedTaskLifecycleRuntime
  | undefined {
  return requireActivePluginRegistry().detachedTaskRuntimes[0]?.runtime;
}

/** Core creation retains its activation; plugin work follows its exact live instance. */
export function captureDetachedTaskRuntimeOwner(): {
  runtime: DetachedTaskLifecycleRuntime | undefined;
  assertCurrent: () => void;
} {
  const registry = requireActivePluginRegistry();
  const registration = registry.detachedTaskRuntimes[0];
  const runtime = registration?.runtime;
  const pluginId = registration?.pluginId;
  const record = registration
    ? registry.plugins.find((candidate) => candidate.id === pluginId)
    : undefined;
  const authority = record
    ? capturePluginLifecycleAuthority(getPluginRecordRegistry(registry, record), record)
    : undefined;
  const epoch = registration ? undefined : capturePluginRegistryLifecycleEpoch(registry);
  return {
    runtime,
    assertCurrent() {
      if (registration) {
        const owner = record ? getPluginRecordRegistry(registry, record) : undefined;
        if (
          authority?.() &&
          owner?.detachedTaskRuntimes.some(
            (candidate) => candidate.pluginId === pluginId && candidate.runtime === runtime,
          )
        ) {
          return;
        }
      } else if (
        epoch &&
        isPluginRegistryLifecycleEpochActive(registry, epoch) &&
        getPluginRegistryForContext() === registry &&
        registry.detachedTaskRuntimes[0] === undefined
      ) {
        return;
      }
      throw new DetachedTaskRuntimeOwnerRetiredError();
    },
  };
}
