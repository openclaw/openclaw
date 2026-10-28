import type { PluginToolExecutionCapabilities } from "../agents/plugin-tool-execution.js";
import { getActiveRuntimePluginRegistry } from "./active-runtime-registry.js";
import { assertMemoryAudienceSession } from "./memory-audience.js";
import { resolveMemoryCapabilityRegistration } from "./memory-state.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { capturePluginLifecycleAuthority, getPluginRecordRegistry } from "./registry-lifecycle.js";
import type { PluginRegistry, PluginToolRegistration } from "./registry-types.js";
import type { OpenClawPluginToolContext } from "./tool-types.js";

/** Host-only identity binding; registration opt-in never creates this authority. */
export type PluginToolOwnerContinuation = {
  isCurrent: () => boolean;
  assertCurrent: () => void;
  senderId?: string;
  channel?: string;
  accountId?: string;
};

/** One binding supplies both the factory's final-effect guard and its retained callbacks. */
export function createPluginToolFactoryContext(params: {
  entry: PluginToolRegistration;
  registry: PluginRegistry;
  context: OpenClawPluginToolContext;
  assertInvocationCurrent?: () => void;
  ownerContinuation?: PluginToolOwnerContinuation;
  bindExecutionCapabilities?: (
    assertCurrent: () => void,
    signal?: AbortSignal,
    handoff?: {
      pluginId: string;
      toolName: string;
      methods: readonly string[];
      assertPluginCurrent(): void;
    },
  ) => PluginToolExecutionCapabilities;
}): OpenClawPluginToolContext {
  const { entry, registry, context } = params;
  if (context.memoryAudience) {
    assertMemoryAudienceSession(context.memoryAudience, context.sessionKey);
  }
  const record = registry.plugins.find((candidate) => candidate.id === entry.pluginId);
  const authority = capturePluginLifecycleAuthority(registry, record, { scopedRuntime: true });
  // A prepared turn may borrow a live plugin record. Its registry retires when the
  // turn yields, while the exact Gateway-owned instance remains in service.
  const serviceRegistry = getActiveRuntimePluginRegistry();
  const serviceAuthority =
    record &&
    serviceRegistry?.plugins.includes(record) &&
    getPluginRecordRegistry(registry, record) === serviceRegistry
      ? capturePluginLifecycleAuthority(serviceRegistry, record, { scopedRuntime: true })
      : undefined;
  const continuation = entry.contextVersion === 2 ? params.ownerContinuation : undefined;
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
    if (entry.contextVersion === 2 && !params.assertInvocationCurrent && !continuation) {
      throw new Error(
        "Plugin tool invocation authority is unavailable outside an admitted run or request",
      );
    }
    params.assertInvocationCurrent?.();
    continuation?.assertCurrent();
    assertMemoryAudienceCurrent?.();
  };
  return {
    ...context,
    ...(entry.contextVersion === 2
      ? params.bindExecutionCapabilities?.(
          assertInvocationCurrent,
          record && getPluginInstance(record)?.lifecycle.signal,
          entry.gatewayHandoffMethods && entry.names.length === 1 && serviceAuthority
            ? {
                pluginId: entry.pluginId,
                toolName: entry.names[0]!,
                methods: entry.gatewayHandoffMethods,
                assertPluginCurrent: () => {
                  if (getActiveRuntimePluginRegistry() !== serviceRegistry || !serviceAuthority()) {
                    throw new Error(`Plugin "${entry.pluginId}" tool runtime is no longer active.`);
                  }
                },
              }
            : undefined,
        )
      : {}),
    ...(continuation
      ? {
          requesterSenderId: continuation.senderId,
          messageChannel: continuation.channel,
          agentAccountId: continuation.accountId,
        }
      : {}),
    get senderIsOwner() {
      return continuation ? continuation.isCurrent() : context.senderIsOwner;
    },
    // V1 callers may inspect metadata or run one-shot tools without an admitted
    // invocation. Do not present a lifecycle-only check as host authority.
    assertInvocationCurrent:
      entry.contextVersion === 2 || params.assertInvocationCurrent || continuation
        ? assertInvocationCurrent
        : undefined,
  };
}
