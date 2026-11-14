import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isInstalledPluginEnabled } from "../../plugins/installed-plugin-index.js";
import { resolvePluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import type { ChannelMessageActionName } from "./message-action-names.js";
import { isSafeManifestChannelId } from "./read-only-command-defaults.js";
import { buildManifestChannelPlugin } from "./read-only.js";
import type { AnyChannelPlugin as ChannelPlugin } from "./types.plugin.js";

/**
 * Builds a runtime-free channel adapter for a manifest-declared Gateway-owned message
 * action. The Gateway's loaded plugin executes it; this process only routes the request.
 */
export function resolveGatewayDelegatedChannelPlugin(params: {
  channelId: string;
  action: ChannelMessageActionName;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): ChannelPlugin | undefined {
  if (!isSafeManifestChannelId(params.channelId)) {
    return undefined;
  }
  const snapshot = resolvePluginMetadataSnapshot({
    config: params.config,
    env: params.env ?? process.env,
    allowWorkspaceScopedCurrent: true,
  });
  for (const record of snapshot.plugins) {
    if (
      !record.channels.includes(params.channelId) ||
      !isInstalledPluginEnabled(snapshot.index, record.id, params.config)
    ) {
      continue;
    }
    const channelConfig =
      record.channelConfigs && Object.hasOwn(record.channelConfigs, params.channelId)
        ? record.channelConfigs[params.channelId]
        : undefined;
    const gatewayActions = new Set(channelConfig?.gatewayMessageActions);
    const plugin = gatewayActions.has(params.action)
      ? buildManifestChannelPlugin({ record, channelId: params.channelId })
      : undefined;
    if (!plugin) {
      continue;
    }
    return {
      ...plugin,
      config: {
        ...plugin.config,
        // The Gateway's plugin owns account membership. A root-token or environment default
        // can sit beside named accounts, so the route must not reject it locally.
        listAccountIds: (cfg) => [
          ...new Set([DEFAULT_ACCOUNT_ID, ...plugin.config.listAccountIds(cfg)]),
        ],
      },
      // Gateway delivery marks the adapter as a selected sender, so outbound
      // resolution does not bootstrap the channel runtime this adapter replaces.
      outbound: { deliveryMode: "gateway" },
      actions: {
        describeMessageTool: () => ({ actions: [...gatewayActions] }),
        supportsAction: ({ action }) => gatewayActions.has(action),
        resolveExecutionMode: () => "gateway",
        handleAction: async () => {
          throw new Error(
            `Channel ${params.channelId} action ${params.action} requires its plugin in the Gateway.`,
          );
        },
      },
    };
  }
  return undefined;
}
