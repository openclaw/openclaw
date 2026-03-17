import { createLazyRuntimeMethod, createLazyRuntimeSurface } from "../../shared/lazy-runtime.js";
import type { PluginRuntimeChannel } from "./types-channel.js";

type RuntimeSlackOps = typeof import("./runtime-slack-ops.runtime.js").runtimeSlackOps;

const loadRuntimeSlackOps = createLazyRuntimeSurface(
  () => import("./runtime-slack-ops.runtime.js"),
  ({ runtimeSlackOps }) => runtimeSlackOps,
);

const listDirectoryGroupsLiveLazy = createLazyRuntimeMethod<
  RuntimeSlackOps,
  Parameters<PluginRuntimeChannel["slack"]["listDirectoryGroupsLive"]>,
  ReturnType<PluginRuntimeChannel["slack"]["listDirectoryGroupsLive"]>
>(loadRuntimeSlackOps, (runtimeSlackOps) => runtimeSlackOps.listDirectoryGroupsLive);

const listDirectoryPeersLiveLazy = createLazyRuntimeMethod<
  RuntimeSlackOps,
  Parameters<PluginRuntimeChannel["slack"]["listDirectoryPeersLive"]>,
  ReturnType<PluginRuntimeChannel["slack"]["listDirectoryPeersLive"]>
>(loadRuntimeSlackOps, (runtimeSlackOps) => runtimeSlackOps.listDirectoryPeersLive);

const probeSlackLazy = createLazyRuntimeMethod<
  RuntimeSlackOps,
  Parameters<PluginRuntimeChannel["slack"]["probeSlack"]>,
  ReturnType<PluginRuntimeChannel["slack"]["probeSlack"]>
>(loadRuntimeSlackOps, (runtimeSlackOps) => runtimeSlackOps.probeSlack);

const resolveChannelAllowlistLazy = createLazyRuntimeMethod<
  RuntimeSlackOps,
  Parameters<PluginRuntimeChannel["slack"]["resolveChannelAllowlist"]>,
  ReturnType<PluginRuntimeChannel["slack"]["resolveChannelAllowlist"]>
>(loadRuntimeSlackOps, (runtimeSlackOps) => runtimeSlackOps.resolveChannelAllowlist);

const resolveUserAllowlistLazy = createLazyRuntimeMethod<
  RuntimeSlackOps,
  Parameters<PluginRuntimeChannel["slack"]["resolveUserAllowlist"]>,
  ReturnType<PluginRuntimeChannel["slack"]["resolveUserAllowlist"]>
>(loadRuntimeSlackOps, (runtimeSlackOps) => runtimeSlackOps.resolveUserAllowlist);

const sendMessageSlackLazy = createLazyRuntimeMethod<
  RuntimeSlackOps,
  Parameters<PluginRuntimeChannel["slack"]["sendMessageSlack"]>,
  ReturnType<PluginRuntimeChannel["slack"]["sendMessageSlack"]>
>(loadRuntimeSlackOps, (runtimeSlackOps) => runtimeSlackOps.sendMessageSlack);

const monitorSlackProviderLazy = createLazyRuntimeMethod<
  RuntimeSlackOps,
  Parameters<PluginRuntimeChannel["slack"]["monitorSlackProvider"]>,
  ReturnType<PluginRuntimeChannel["slack"]["monitorSlackProvider"]>
>(loadRuntimeSlackOps, (runtimeSlackOps) => runtimeSlackOps.monitorSlackProvider);

const handleSlackActionLazy = createLazyRuntimeMethod<
  RuntimeSlackOps,
  Parameters<PluginRuntimeChannel["slack"]["handleSlackAction"]>,
  ReturnType<PluginRuntimeChannel["slack"]["handleSlackAction"]>
>(loadRuntimeSlackOps, (runtimeSlackOps) => runtimeSlackOps.handleSlackAction);

export function createRuntimeSlack(): PluginRuntimeChannel["slack"] {
  return {
    listDirectoryGroupsLive: listDirectoryGroupsLiveLazy,
    listDirectoryPeersLive: listDirectoryPeersLiveLazy,
    probeSlack: probeSlackLazy,
    resolveChannelAllowlist: resolveChannelAllowlistLazy,
    resolveUserAllowlist: resolveUserAllowlistLazy,
    sendMessageSlack: sendMessageSlackLazy,
    monitorSlackProvider: monitorSlackProviderLazy,
    handleSlackAction: handleSlackActionLazy,
  };
}
