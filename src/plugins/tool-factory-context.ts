import { capturePluginLifecycleAuthority } from "./registry-lifecycle.js";
import type { PluginRegistry, PluginToolRegistration } from "./registry-types.js";
import { getPluginToolCallbackInvocation } from "./tool-callback-invocation.js";
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
  runId?: string;
}): OpenClawPluginToolContext<2> {
  const { entry, registry, context } = params;
  const record = registry.plugins.find((candidate) => candidate.id === entry.pluginId);
  const authority = capturePluginLifecycleAuthority(registry, record, { scopedRuntime: true });
  const continuation = entry.contextVersion === 2 ? params.ownerContinuation : undefined;
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
  };
  return {
    ...context,
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
    assertInvocationCurrent,
    issueAsyncCallback: async ({ ttlMs }) => {
      if (entry.contextVersion !== 2) {
        throw new Error("Async callback requires a version 2 plugin tool");
      }
      const invocation = getPluginToolCallbackInvocation();
      const toolName = invocation?.toolName;
      if (
        invocation?.pluginId !== entry.pluginId ||
        !toolName ||
        (entry.declaredNames && !entry.declaredNames.has(toolName))
      ) {
        throw new Error("Async callback must be issued during registered tool execution");
      }
      // Rechecked through the async import and worker admission, so a call that
      // outlives execute cannot persist a callback row.
      const assertExecutionCurrent = () => {
        if (!invocation.isActive()) {
          throw new Error("Async callback must be issued during registered tool execution");
        }
        assertInvocationCurrent();
      };
      assertExecutionCurrent();
      const { issueHostPluginAsyncCallback } =
        await import("../agents/plugin-async-callback.host.js");
      return issueHostPluginAsyncCallback({
        pluginId: entry.pluginId,
        toolName,
        runId: params.runId,
        sessionKey: context.sessionKey,
        sessionId: context.sessionId,
        agentId: context.agentId,
        ttlMs,
        assertInvocationCurrent: assertExecutionCurrent,
        assertPluginCurrent: () => {
          if (!authority?.()) {
            throw new Error(`Plugin "${entry.pluginId}" tool runtime is no longer active.`);
          }
        },
      });
    },
  };
}
