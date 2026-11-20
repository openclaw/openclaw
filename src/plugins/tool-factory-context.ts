import {
  assertPluginToolInvocationSourceCurrent,
  capturePluginToolInvocationAssertion,
} from "../agents/agent-tool-source-execution-guard.js";
import type { PluginToolExecutionCapabilities } from "../agents/plugin-tool-execution.js";
import { resolveCommandConversationResolution } from "../channels/conversation-resolution.js";
import { createPluginConversationBindingScope } from "./conversation-binding-authority.js";
import { assertMemoryAudienceSession } from "./memory-audience.js";
import { resolveMemoryCapabilityRegistration } from "./memory-state.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { capturePluginLifecycleAuthority } from "./registry-lifecycle.js";
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
  ) => PluginToolExecutionCapabilities;
}): OpenClawPluginToolContext {
  const { entry, registry, context } = params;
  if (context.memoryAudience) {
    assertMemoryAudienceSession(context.memoryAudience, context.sessionKey);
  }
  const record = registry.plugins.find((candidate) => candidate.id === entry.pluginId);
  const authority = capturePluginLifecycleAuthority(registry, record, { scopedRuntime: true });
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
    // The caller that invoked this tool call, captured when the call began.
    assertPluginToolInvocationSourceCurrent();
    continuation?.assertCurrent();
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
    ...(continuation
      ? {
          requesterSenderId: continuation.senderId,
          messageChannel: continuation.channel,
          agentAccountId: continuation.accountId,
        }
      : {}),
    // Never inherit a caller-supplied capability, including on legacy factory contexts.
    withCurrentConversationBinding:
      entry.contextVersion === 2
        ? async (action) => {
            const assertToolCallCurrent = capturePluginToolInvocationAssertion();
            assertInvocationCurrent();
            const channel = continuation?.channel ?? context.messageChannel;
            const plugin = registry.channels.find(
              (candidate) => candidate.plugin.id === channel,
            )?.plugin;
            const config =
              context.getRuntimeConfig?.() ?? context.runtimeConfig ?? context.config ?? {};
            const senderId = continuation?.senderId ?? context.requesterSenderId;
            const conversation = plugin
              ? resolveCommandConversationResolution({
                  cfg: config,
                  plugin,
                  channel,
                  senderId,
                  accountId:
                    continuation?.accountId ??
                    context.agentAccountId ??
                    context.deliveryContext?.accountId,
                  nativeChannelId: context.nativeChannelId,
                  originatingTo: context.deliveryContext?.to,
                  threadId: context.deliveryContext?.threadId,
                  sessionKey: context.sessionKey,
                })
              : null;
            return createPluginConversationBindingScope({
              pluginId: entry.pluginId,
              pluginRoot: entry.rootDir ?? record?.rootDir,
              senderId,
              conversation,
              config,
              agentId: context.agentId,
              sessionKey: context.sessionKey,
              sessionId: context.sessionId,
              assertCurrent: () => {
                assertInvocationCurrent();
                assertToolCallCurrent();
              },
            })(action);
          }
        : undefined,
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
