import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getPluginRegistryGatewayChannelRegistration } from "../../plugins/registry-lifecycle.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { getLoadedChannelPluginEntryById } from "./registry-loaded.js";

export function resolveChannelMessagingConfig(
  cfg: OpenClawConfig,
  channel: string,
  accountId?: string | null,
) {
  const registry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  // A filtered turn registry retains the admitting channel's config owner.
  const plugin = registry
    ? (getLoadedChannelPluginEntryById(channel, registry)?.plugin ??
      getPluginRegistryGatewayChannelRegistration(registry, channel)?.plugin)
    : getLoadedChannelPluginEntryById(channel)?.plugin;
  return plugin?.config.resolveMessagingConfig?.(cfg, accountId);
}
