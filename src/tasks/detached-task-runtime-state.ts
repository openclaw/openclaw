import {
  capturePluginLifecycleAuthority,
  getPluginRecordRegistry,
  getPluginRegistryGatewayOwner,
  isPluginRegistryRetired,
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

/**
 * Core work retains its scoped owner; plugin work follows its exact live instance.
 * Settlement and lookup of already-admitted work may move from a retired
 * generation to its admitting Gateway's current registry while core owns tasks
 * in both. New work never leaves its admitting scope.
 */
export function captureDetachedTaskRuntimeOwner(options?: { settlement?: boolean }): {
  runtime: DetachedTaskLifecycleRuntime | undefined;
  assertCurrent: () => void;
} {
  const scoped = requireActivePluginRegistry();
  // Only the Gateway that admitted this work supplies its successor. A closing,
  // unlinked or disputed owner leaves the strict check on the retired scope.
  const gateway = options?.settlement === true ? getPluginRegistryGatewayOwner(scoped) : undefined;
  const live = gateway?.current();
  const adopted =
    gateway &&
    live &&
    live !== scoped &&
    isPluginRegistryRetired(scoped) &&
    !scoped.detachedTaskRuntimes[0] &&
    !live.detachedTaskRuntimes[0]
      ? { gateway, registry: live }
      : undefined;
  const registry = adopted?.registry ?? scoped;
  const currentRegistry = adopted ? adopted.gateway.current : getPluginRegistryForContext;
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
        currentRegistry() === registry &&
        registry.detachedTaskRuntimes[0] === undefined
      ) {
        return;
      }
      throw new DetachedTaskRuntimeOwnerRetiredError();
    },
  };
}
