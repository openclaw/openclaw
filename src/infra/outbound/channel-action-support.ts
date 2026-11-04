import type { AnyChannelPlugin as ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelMessageActionName } from "../../channels/plugins/types.public.js";

/** Action handlers are independent of the ordinary outbound transport. */
export function hasChannelMessageActionHandler(
  plugin: ChannelPlugin | undefined,
  action?: ChannelMessageActionName,
): boolean {
  const actions = plugin?.actions;
  return Boolean(action && actions?.handleAction && (actions.supportsAction?.({ action }) ?? true));
}
