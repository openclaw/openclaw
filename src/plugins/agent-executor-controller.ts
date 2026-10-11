import { AsyncLocalStorage } from "node:async_hooks";
import type {
  AgentExecutorBinding,
  AgentExecutorContext,
  AgentExecutorController,
} from "./agent-executor-controller.types.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import {
  capturePluginLifecycleAuthority,
  capturePluginRegistryLifecycleEpoch,
  capturePluginRegistryLifecycleSignal,
} from "./registry-lifecycle.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "./runtime/gateway-request-scope.js";

/** Resolve one enabled owner from this invocation, without loading or selecting another registry. */
export function resolveAgentExecutorController(pluginId: string): AgentExecutorController {
  const registry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  if (!registry) {
    throw new Error("Agent executor controller resolution requires a scoped plugin registry");
  }
  const registration = registry.agentExecutorControllers.get(pluginId);
  const record = registry.plugins.find((entry) => entry.id === pluginId);
  const isRegistryCurrent = capturePluginLifecycleAuthority(registry, undefined, {
    scopedRuntime: true,
  });
  const isOwnerCurrent =
    record &&
    capturePluginLifecycleAuthority(registry, record, {
      scopedRuntime: true,
    });
  if (!registration || !record || !isRegistryCurrent || !isOwnerCurrent) {
    throw new Error(
      `Agent executor controller plugin "${pluginId}" is missing, disabled, or unavailable`,
    );
  }
  const registrySignal = capturePluginRegistryLifecycleSignal(
    registry,
    capturePluginRegistryLifecycleEpoch(registry),
    { scopedRuntime: true },
  );
  const instance = getPluginInstance(record);
  const ownerSignal = instance?.lifecycle.signal;
  const assertAvailable = () => {
    if (
      !isRegistryCurrent() ||
      !isOwnerCurrent() ||
      getPluginRuntimeGatewayRequestScope()?.pluginRegistry !== registry ||
      registry.agentExecutorControllers.get(pluginId) !== registration ||
      registry.plugins.find((entry) => entry.id === pluginId) !== record
    ) {
      throw new Error(`Agent executor controller plugin "${pluginId}" is no longer available`);
    }
  };
  const invoke = async (
    method: "ensure" | "retire",
    binding: AgentExecutorBinding,
    context: AgentExecutorContext,
  ) => {
    const assertCallerCurrent = context.assertCurrent;
    const signal = AbortSignal.any([
      context.signal,
      ...(registrySignal ? [registrySignal] : []),
      ...(ownerSignal ? [ownerSignal] : []),
    ]);
    let active = true;
    const assertCurrent = AsyncLocalStorage.bind(() => {
      if (!active) {
        throw new Error("Agent executor controller operation has completed");
      }
      assertAvailable();
      signal.throwIfAborted();
      assertCallerCurrent();
    });
    assertCurrent();
    try {
      const run = () => registration.controller[method](binding, { signal, assertCurrent });
      await (instance
        ? instance.runInRegistry(registry, run)
        : withPluginRuntimeRegistryScope(registry, run));
      assertCurrent();
    } finally {
      active = false;
    }
  };
  return Object.freeze({
    get workspaceDirectory() {
      assertAvailable();
      return registration.controller.workspaceDirectory;
    },
    ensure: (binding: AgentExecutorBinding, context: AgentExecutorContext) =>
      invoke("ensure", binding, context),
    retire: (binding: AgentExecutorBinding, context: AgentExecutorContext) =>
      invoke("retire", binding, context),
  });
}
