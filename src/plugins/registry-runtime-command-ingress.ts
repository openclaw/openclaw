import type { PluginRecord } from "./registry-types.js";
import type { PluginRuntime } from "./runtime/types.js";
import { normalizePluginToolContractNames } from "./tool-contracts.js";

type PluginCommandIngressOpts = Parameters<PluginRuntime["agent"]["runCommandFromIngress"]>[0];

/**
 * Admits one plugin-runtime agent turn. Owner authority comes only from the exact trusted
 * plugin of the named channel; a turn without a channel is a guest turn; tool bindings may
 * scope only tools the plugin declares.
 */
export function admitPluginCommandIngress(params: {
  pluginId: string;
  record: PluginRecord;
  opts: PluginCommandIngressOpts;
  isRecordCurrent: () => boolean;
  ownsChannel: (channelId: string) => boolean;
}): PluginCommandIngressOpts {
  const { pluginId, record } = params;
  const { senderIsOwner: claimedOwner, messageChannel, toolBindings, ...remaining } = params.opts;
  const senderIsOwner = claimedOwner === true;
  // Validate and dispatch the same host-owned values; never re-read plugin-owned authority.
  const admitted = {
    ...remaining,
    senderIsOwner,
    messageChannel,
    ...(toolBindings ? { toolBindings: structuredClone(toolBindings) } : {}),
  };
  const declaredTools = new Set(normalizePluginToolContractNames(record.contracts));
  const foreignBinding = Object.keys(admitted.toolBindings ?? {}).find(
    (name) => !declaredTools.has(name),
  );
  if (foreignBinding !== undefined) {
    throw new Error(
      `Plugin "${pluginId}" cannot bind tool "${foreignBinding}" it does not declare.`,
    );
  }
  if (
    // Community channels may admit guests; trusted provenance is required only for owner elevation.
    (senderIsOwner && record.origin !== "bundled" && record.trustedOfficialInstall !== true) ||
    !params.isRecordCurrent() ||
    // A plugin that owns no channel (such as a phone bridge) admits guest turns only.
    (messageChannel === undefined ? senderIsOwner : !params.ownsChannel(messageChannel))
  ) {
    throw new Error(
      `Plugin "${pluginId}" cannot admit authenticated owner authority for channel "${messageChannel ?? "unknown"}".`,
    );
  }
  return admitted;
}
