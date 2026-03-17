import type { PluginRuntimeChannel } from "./types-channel.js";

type RuntimeSlackOps = typeof import("./runtime-slack-ops.runtime.js").runtimeSlackOps;

let runtimeSlackOpsPromise: Promise<RuntimeSlackOps> | null = null;

function loadRuntimeSlackOps() {
  runtimeSlackOpsPromise ??= import("./runtime-slack-ops.runtime.js").then(
    ({ runtimeSlackOps }) => runtimeSlackOps,
  );
  return runtimeSlackOpsPromise;
}

const listDirectoryGroupsLiveLazy: PluginRuntimeChannel["slack"]["listDirectoryGroupsLive"] =
  async (...args) => {
    const runtimeSlackOps = await loadRuntimeSlackOps();
    return runtimeSlackOps.listDirectoryGroupsLive(...args);
  };

const listDirectoryPeersLiveLazy: PluginRuntimeChannel["slack"]["listDirectoryPeersLive"] = async (
  ...args
) => {
  const runtimeSlackOps = await loadRuntimeSlackOps();
  return runtimeSlackOps.listDirectoryPeersLive(...args);
};

const probeSlackLazy: PluginRuntimeChannel["slack"]["probeSlack"] = async (...args) => {
  const runtimeSlackOps = await loadRuntimeSlackOps();
  return runtimeSlackOps.probeSlack(...args);
};

const resolveChannelAllowlistLazy: PluginRuntimeChannel["slack"]["resolveChannelAllowlist"] =
  async (...args) => {
    const runtimeSlackOps = await loadRuntimeSlackOps();
    return runtimeSlackOps.resolveChannelAllowlist(...args);
  };

const resolveUserAllowlistLazy: PluginRuntimeChannel["slack"]["resolveUserAllowlist"] = async (
  ...args
) => {
  const runtimeSlackOps = await loadRuntimeSlackOps();
  return runtimeSlackOps.resolveUserAllowlist(...args);
};

const sendMessageSlackLazy: PluginRuntimeChannel["slack"]["sendMessageSlack"] = async (...args) => {
  const runtimeSlackOps = await loadRuntimeSlackOps();
  return runtimeSlackOps.sendMessageSlack(...args);
};

const monitorSlackProviderLazy: PluginRuntimeChannel["slack"]["monitorSlackProvider"] = async (
  ...args
) => {
  const runtimeSlackOps = await loadRuntimeSlackOps();
  return runtimeSlackOps.monitorSlackProvider(...args);
};

const handleSlackActionLazy: PluginRuntimeChannel["slack"]["handleSlackAction"] = async (
  ...args
) => {
  const runtimeSlackOps = await loadRuntimeSlackOps();
  return runtimeSlackOps.handleSlackAction(...args);
};

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
