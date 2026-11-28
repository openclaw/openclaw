import type { PluginToolExecutionCapabilities } from "../agents/plugin-tool-execution.js";
import { assertMemoryAudienceSession } from "./memory-audience.js";
import { resolveMemoryCapabilityRegistration } from "./memory-state.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { capturePluginLifecycleAuthority } from "./registry-lifecycle.js";
import type { PluginRegistry, PluginToolRegistration } from "./registry-types.js";
import type { OpenClawPluginToolContext } from "./tool-types.js";

/** One binding supplies both the factory's final-effect guard and its retained callbacks. */
export function createPluginToolFactoryContext(params: {
  entry: PluginToolRegistration;
  registry: PluginRegistry;
  context: OpenClawPluginToolContext;
  assertInvocationCurrent?: () => void;
  bindExecutionCapabilities?: (
    assertCurrent: () => void,
    signal?: AbortSignal,
  ) => PluginToolExecutionCapabilities;
}): OpenClawPluginToolContext {
  const { entry, registry, context } = params;
  if (context.memoryAudience) {
    assertMemoryAudienceSession(context.memoryAudience, context.sessionKey);
  }
  const record = registry.plugins.find((candidate) => candidate.id === entry.pluginId);
  const authority = capturePluginLifecycleAuthority(registry, record, { scopedRuntime: true });
  // Audience currency guards memory effects: the memory slot owner's own tools. Other
  // plugins reach memory through the provider guard, so a stale audience never fails them.
  const assertMemoryAudienceCurrent =
    resolveMemoryCapabilityRegistration(registry.memoryCapabilities)?.pluginId === entry.pluginId
      ? context.assertMemoryAudienceCurrent
      : undefined;
  const assertInvocationCurrent = () => {
    if (!authority?.()) {
      throw new Error(`Plugin "${entry.pluginId}" tool runtime is no longer active.`);
    }
    if (entry.contextVersion === 2 && !params.assertInvocationCurrent) {
      throw new Error(
        "Plugin tool invocation authority is unavailable outside an admitted run or request",
      );
    }
    params.assertInvocationCurrent?.();
    assertMemoryAudienceCurrent?.();
  };
  return {
    ...context,
    ...(entry.contextVersion === 2
      ? params.bindExecutionCapabilities?.(
          assertInvocationCurrent,
          record && getPluginInstance(record)?.lifecycle.signal,
        )
      : {}),
    // V1 callers may inspect metadata or run one-shot tools without an admitted
    // invocation. Do not present a lifecycle-only check as host authority.
    assertInvocationCurrent:
      entry.contextVersion === 2 || params.assertInvocationCurrent
        ? assertInvocationCurrent
        : undefined,
  };
}
