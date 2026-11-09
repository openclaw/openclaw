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
