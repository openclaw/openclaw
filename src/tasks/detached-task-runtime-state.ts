import {
  capturePluginLifecycleAuthority,
  getPluginRecordRegistry,
} from "../plugins/registry-lifecycle.js";
import { getPluginRegistryForContext, requireActivePluginRegistry } from "../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  DetachedTaskRuntimeOwnerRetiredError,
  type DetachedTaskLifecycleRuntime,
} from "./detached-task-runtime-contract.js";

export function getRegisteredDetachedTaskLifecycleRuntime():
  | DetachedTaskLifecycleRuntime
  | undefined {
  return requireActivePluginRegistry().detachedTaskRuntimes[0]?.runtime;
}

/** Core creation retains its scoped owner; plugin work follows its exact live instance. */
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
  // Local runs own scoped handles without publishing a Gateway activation.
  // Core handles retain that scope; plugin callbacks follow their exact instance.
  const authority = capturePluginLifecycleAuthority(
    record ? getPluginRecordRegistry(registry, record) : registry,
    record,
    { scopedRuntime: getPluginRuntimeGatewayRequestScope()?.pluginRegistry === registry },
  );
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
        authority?.() &&
        getPluginRegistryForContext() === registry &&
        registry.detachedTaskRuntimes[0] === undefined
      ) {
        return;
      }
      throw new DetachedTaskRuntimeOwnerRetiredError();
    },
  };
}
