import { AsyncLocalStorage } from "node:async_hooks";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";

type PluginToolCallbackInvocation = {
  pluginId: string;
  toolName: string;
  /** Detached work inherits this store, so settlement must close it explicitly. */
  isActive: () => boolean;
};

const invocation = new AsyncLocalStorage<PluginToolCallbackInvocation>();

/**
 * The actual registered tool name, not a plugin-provided callback destination.
 * Callback authority ends when this execution settles, even for timers or
 * promises that inherited the async context.
 */
export function withPluginToolCallbackInvocation<T>(
  pluginId: string,
  toolName: string,
  run: () => T,
): T {
  let active = true;
  const close = () => {
    active = false;
  };
  let result: T;
  try {
    result = invocation.run({ pluginId, toolName, isActive: () => active }, run);
  } catch (error) {
    close();
    throw error;
  }
  if (!isPromiseLike(result)) {
    close();
    return result;
  }
  return Promise.resolve(result).finally(close) as T; // SAFETY: Only promise-like results enter this branch; the settled value is unchanged.
}

export function getPluginToolCallbackInvocation(): PluginToolCallbackInvocation | undefined {
  return invocation.getStore();
}
