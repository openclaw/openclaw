import {
  capturePluginLifecycleAuthority,
  isPluginRecordActive,
  isPluginRegistryPreparing,
} from "./registry-lifecycle.js";
import type { PluginRegistryState } from "./registry-state.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";
import {
  getGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "./runtime/gateway-request-scope.js";
import type { PluginRuntime } from "./runtime/types.js";

/** Bind system operations and their awaited effects to the admitted plugin and Gateway. */
export function createPluginSystemRuntime(params: {
  state: PluginRegistryState;
  record: PluginRecord;
  system: PluginRuntime["system"];
  currentRegistry: () => PluginRegistry;
  assertRuntimeCurrent: () => void;
  runWithPluginScope: <T>(run: () => T) => T;
}): PluginRuntime["system"] {
  const {
    state: { registry, registryParams },
    record,
    system,
    currentRegistry,
    assertRuntimeCurrent,
    runWithPluginScope,
  } = params;
  const pluginId = record.id;
  const route = <T>(run: () => T): T => {
    assertRuntimeCurrent();
    if (isPluginRegistryPreparing(registry) && !isPluginRecordActive(registry, record)) {
      throw new Error(
        `Plugin "${pluginId}" cannot route system events during replacement preparation.`,
      );
    }
    const authority = capturePluginLifecycleAuthority(currentRegistry(), record, {
      scopedRuntime: registryParams.activateGlobalSideEffects === false,
      registration: true,
      admittedRuntime: true,
    });
    const resolveGatewayContext = getGatewayContextResolver(registryParams.runtime.subagent);
    const context = resolveGatewayContext?.();
    const assertCurrent = () => {
      if (!authority?.()) {
        throw new Error(`Plugin "${pluginId}" system owner is no longer active.`);
      }
      if (resolveGatewayContext && (!context || resolveGatewayContext() !== context)) {
        throw new Error(`Plugin "${pluginId}" Gateway owner is no longer active.`);
      }
    };
    assertCurrent();
    return runWithPluginScope(() =>
      withPluginRuntimeGatewayRequestScope(
        {
          ...getPluginRuntimeGatewayRequestScope(),
          isWebchatConnect: () => false,
          resolveGatewayContext,
          assertSystemOwnerCurrent: assertCurrent,
        },
        run,
      ),
    );
  };
  return {
    ...system,
    captureSessionEventTarget: (...args) => route(() => system.captureSessionEventTarget(...args)),
    enqueueSessionEvent: (...args) => route(() => system.enqueueSessionEvent(...args)),
    enqueueSystemEvent: (...args) => route(() => system.enqueueSystemEvent(...args)),
    runCommandWithTimeout: (...args) =>
      runWithPluginScope(() => system.runCommandWithTimeout(...args)),
  } satisfies PluginRuntime["system"];
}
