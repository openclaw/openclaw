import type { PluginRuntimeChannel } from "./types-channel.js";

let runtimeSlackOpsPromise: Promise<typeof import("./runtime-slack-ops.runtime.js")> | null = null;

function loadRuntimeSlackOps() {
  runtimeSlackOpsPromise ??= import("./runtime-slack-ops.runtime.js");
  return runtimeSlackOpsPromise;
}

const listDirectoryGroupsLiveLazy: PluginRuntimeChannel["slack"]["listDirectoryGroupsLive"] =
  async (...args) => {
    const { listSlackDirectoryGroupsLive } = await loadRuntimeSlackOps();
    return listSlackDirectoryGroupsLive(...args);
  };

const listDirectoryPeersLiveLazy: PluginRuntimeChannel["slack"]["listDirectoryPeersLive"] = async (
  ...args
) => {
  const { listSlackDirectoryPeersLive } = await loadRuntimeSlackOps();
  return listSlackDirectoryPeersLive(...args);
};

const probeSlackLazy: PluginRuntimeChannel["slack"]["probeSlack"] = async (...args) => {
  const { probeSlack } = await loadRuntimeSlackOps();
  return probeSlack(...args);
};

const resolveChannelAllowlistLazy: PluginRuntimeChannel["slack"]["resolveChannelAllowlist"] =
  async (...args) => {
    const { resolveSlackChannelAllowlist } = await loadRuntimeSlackOps();
    return resolveSlackChannelAllowlist(...args);
  };

const resolveUserAllowlistLazy: PluginRuntimeChannel["slack"]["resolveUserAllowlist"] = async (
  ...args
) => {
  const { resolveSlackUserAllowlist } = await loadRuntimeSlackOps();
  return resolveSlackUserAllowlist(...args);
};

const sendMessageSlackLazy: PluginRuntimeChannel["slack"]["sendMessageSlack"] = async (...args) => {
  const { sendMessageSlack } = await loadRuntimeSlackOps();
  return sendMessageSlack(...args);
};

const monitorSlackProviderLazy: PluginRuntimeChannel["slack"]["monitorSlackProvider"] = async (
  ...args
) => {
  const { monitorSlackProvider } = await loadRuntimeSlackOps();
  return monitorSlackProvider(...args);
};

const handleSlackActionLazy: PluginRuntimeChannel["slack"]["handleSlackAction"] = async (
  ...args
) => {
  const { handleSlackAction } = await loadRuntimeSlackOps();
  return handleSlackAction(...args);
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
