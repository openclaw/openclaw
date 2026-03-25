import {
  createLazyRuntimeMethodBinder,
  createLazyRuntimeSurface,
} from "../../shared/lazy-runtime.js";
import type { PluginRuntimeChannel } from "./types-channel.js";

const loadRuntimeSlackOps = createLazyRuntimeSurface(
  () => import("./runtime-slack-ops.runtime.js"),
  ({ runtimeSlackOps }) => runtimeSlackOps,
);

const bindSlackRuntimeMethod = createLazyRuntimeMethodBinder(loadRuntimeSlackOps);

const listDirectoryGroupsLiveLazy = bindSlackRuntimeMethod(
  (runtimeSlackOps) => runtimeSlackOps.listDirectoryGroupsLive,
);
const listDirectoryPeersLiveLazy = bindSlackRuntimeMethod(
  (runtimeSlackOps) => runtimeSlackOps.listDirectoryPeersLive,
);
const probeSlackLazy = bindSlackRuntimeMethod((runtimeSlackOps) => runtimeSlackOps.probeSlack);
const resolveChannelAllowlistLazy = bindSlackRuntimeMethod(
  (runtimeSlackOps) => runtimeSlackOps.resolveChannelAllowlist,
);
const resolveUserAllowlistLazy = bindSlackRuntimeMethod(
  (runtimeSlackOps) => runtimeSlackOps.resolveUserAllowlist,
);
const sendMessageSlackLazy = bindSlackRuntimeMethod(
  (runtimeSlackOps) => runtimeSlackOps.sendMessageSlack,
);
const monitorSlackProviderLazy = bindSlackRuntimeMethod(
  (runtimeSlackOps) => runtimeSlackOps.monitorSlackProvider,
);
const handleSlackActionLazy = bindSlackRuntimeMethod(
  (runtimeSlackOps) => runtimeSlackOps.handleSlackAction,
);

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
