import { pluginInstanceInvocation } from "../../plugins/plugin-instance-invocation.js";
import {
  getPluginValueInstance,
  wrapCurrentPluginInstance,
} from "../../plugins/plugin-instance-scope.js";

export function bindChannelDeliveryOwner<T extends object>(delivery: T): T {
  const owner = getPluginValueInstance(delivery);
  return owner && owner === pluginInstanceInvocation.getStore()?.instance
    ? delivery
    : wrapCurrentPluginInstance(delivery);
}

/** Reply runs exit the caller's plugin instance; channel callbacks re-enter it, data stays. */
export function bindChannelReplyOptionsOwner<T extends object>(replyOptions: T | undefined) {
  const owner = pluginInstanceInvocation.getStore()?.instance;
  if (!owner || !replyOptions) {
    return replyOptions;
  }
  const bound = { ...replyOptions };
  for (const key of Reflect.ownKeys(bound)) {
    const value: unknown = Reflect.get(bound, key);
    if (typeof value === "function" && getPluginValueInstance(value) !== owner) {
      Reflect.set(bound, key, owner.wrap(value));
    }
  }
  return bound;
}
