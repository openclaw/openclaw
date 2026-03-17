import { discordMessageActions } from "../../../extensions/discord/src/channel-actions.js";
import {
  getThreadBindingManager,
  resolveThreadBindingIdleTimeoutMs,
  resolveThreadBindingInactivityExpiresAt,
  resolveThreadBindingMaxAgeExpiresAt,
  resolveThreadBindingMaxAgeMs,
  setThreadBindingIdleTimeoutBySessionKey,
  setThreadBindingMaxAgeBySessionKey,
  unbindThreadBindingsBySessionKey,
} from "../../../extensions/discord/src/monitor/thread-bindings.js";
import { createDiscordTypingLease } from "./runtime-discord-typing.js";
import type { PluginRuntimeChannel } from "./types-channel.js";

type RuntimeDiscordOps = typeof import("./runtime-discord-ops.runtime.js").runtimeDiscordOps;

let runtimeDiscordOpsPromise: Promise<RuntimeDiscordOps> | null = null;

function loadRuntimeDiscordOps() {
  runtimeDiscordOpsPromise ??= import("./runtime-discord-ops.runtime.js").then(
    ({ runtimeDiscordOps }) => runtimeDiscordOps,
  );
  return runtimeDiscordOpsPromise;
}

const auditChannelPermissionsLazy: PluginRuntimeChannel["discord"]["auditChannelPermissions"] =
  async (...args) => {
    const runtimeDiscordOps = await loadRuntimeDiscordOps();
    return runtimeDiscordOps.auditChannelPermissions(...args);
  };

const listDirectoryGroupsLiveLazy: PluginRuntimeChannel["discord"]["listDirectoryGroupsLive"] =
  async (...args) => {
    const runtimeDiscordOps = await loadRuntimeDiscordOps();
    return runtimeDiscordOps.listDirectoryGroupsLive(...args);
  };

const listDirectoryPeersLiveLazy: PluginRuntimeChannel["discord"]["listDirectoryPeersLive"] =
  async (...args) => {
    const runtimeDiscordOps = await loadRuntimeDiscordOps();
    return runtimeDiscordOps.listDirectoryPeersLive(...args);
  };

const probeDiscordLazy: PluginRuntimeChannel["discord"]["probeDiscord"] = async (...args) => {
  const runtimeDiscordOps = await loadRuntimeDiscordOps();
  return runtimeDiscordOps.probeDiscord(...args);
};

const resolveChannelAllowlistLazy: PluginRuntimeChannel["discord"]["resolveChannelAllowlist"] =
  async (...args) => {
    const runtimeDiscordOps = await loadRuntimeDiscordOps();
    return runtimeDiscordOps.resolveChannelAllowlist(...args);
  };

const resolveUserAllowlistLazy: PluginRuntimeChannel["discord"]["resolveUserAllowlist"] = async (
  ...args
) => {
  const runtimeDiscordOps = await loadRuntimeDiscordOps();
  return runtimeDiscordOps.resolveUserAllowlist(...args);
};

const sendComponentMessageLazy: PluginRuntimeChannel["discord"]["sendComponentMessage"] = async (
  ...args
) => {
  const runtimeDiscordOps = await loadRuntimeDiscordOps();
  return runtimeDiscordOps.sendComponentMessage(...args);
};

const sendMessageDiscordLazy: PluginRuntimeChannel["discord"]["sendMessageDiscord"] = async (
  ...args
) => {
  const runtimeDiscordOps = await loadRuntimeDiscordOps();
  return runtimeDiscordOps.sendMessageDiscord(...args);
};

const sendPollDiscordLazy: PluginRuntimeChannel["discord"]["sendPollDiscord"] = async (...args) => {
  const runtimeDiscordOps = await loadRuntimeDiscordOps();
  return runtimeDiscordOps.sendPollDiscord(...args);
};

const monitorDiscordProviderLazy: PluginRuntimeChannel["discord"]["monitorDiscordProvider"] =
  async (...args) => {
    const runtimeDiscordOps = await loadRuntimeDiscordOps();
    return runtimeDiscordOps.monitorDiscordProvider(...args);
  };

const sendTypingDiscordLazy: PluginRuntimeChannel["discord"]["typing"]["pulse"] = async (
  ...args
) => {
  const runtimeDiscordOps = await loadRuntimeDiscordOps();
  return runtimeDiscordOps.typing.pulse(...args);
};

const editMessageDiscordLazy: PluginRuntimeChannel["discord"]["conversationActions"]["editMessage"] =
  async (...args) => {
    const runtimeDiscordOps = await loadRuntimeDiscordOps();
    return runtimeDiscordOps.conversationActions.editMessage(...args);
  };

const deleteMessageDiscordLazy: PluginRuntimeChannel["discord"]["conversationActions"]["deleteMessage"] =
  async (...args) => {
    const runtimeDiscordOps = await loadRuntimeDiscordOps();
    return runtimeDiscordOps.conversationActions.deleteMessage(...args);
  };

const pinMessageDiscordLazy: PluginRuntimeChannel["discord"]["conversationActions"]["pinMessage"] =
  async (...args) => {
    const runtimeDiscordOps = await loadRuntimeDiscordOps();
    return runtimeDiscordOps.conversationActions.pinMessage(...args);
  };

const unpinMessageDiscordLazy: PluginRuntimeChannel["discord"]["conversationActions"]["unpinMessage"] =
  async (...args) => {
    const runtimeDiscordOps = await loadRuntimeDiscordOps();
    return runtimeDiscordOps.conversationActions.unpinMessage(...args);
  };

const createThreadDiscordLazy: PluginRuntimeChannel["discord"]["conversationActions"]["createThread"] =
  async (...args) => {
    const runtimeDiscordOps = await loadRuntimeDiscordOps();
    return runtimeDiscordOps.conversationActions.createThread(...args);
  };

const editChannelDiscordLazy: PluginRuntimeChannel["discord"]["conversationActions"]["editChannel"] =
  async (...args) => {
    const runtimeDiscordOps = await loadRuntimeDiscordOps();
    return runtimeDiscordOps.conversationActions.editChannel(...args);
  };

export function createRuntimeDiscord(): PluginRuntimeChannel["discord"] {
  return {
    messageActions: discordMessageActions,
    auditChannelPermissions: auditChannelPermissionsLazy,
    listDirectoryGroupsLive: listDirectoryGroupsLiveLazy,
    listDirectoryPeersLive: listDirectoryPeersLiveLazy,
    probeDiscord: probeDiscordLazy,
    resolveChannelAllowlist: resolveChannelAllowlistLazy,
    resolveUserAllowlist: resolveUserAllowlistLazy,
    sendComponentMessage: sendComponentMessageLazy,
    sendMessageDiscord: sendMessageDiscordLazy,
    sendPollDiscord: sendPollDiscordLazy,
    monitorDiscordProvider: monitorDiscordProviderLazy,
    threadBindings: {
      getManager: getThreadBindingManager,
      resolveIdleTimeoutMs: resolveThreadBindingIdleTimeoutMs,
      resolveInactivityExpiresAt: resolveThreadBindingInactivityExpiresAt,
      resolveMaxAgeMs: resolveThreadBindingMaxAgeMs,
      resolveMaxAgeExpiresAt: resolveThreadBindingMaxAgeExpiresAt,
      setIdleTimeoutBySessionKey: setThreadBindingIdleTimeoutBySessionKey,
      setMaxAgeBySessionKey: setThreadBindingMaxAgeBySessionKey,
      unbindBySessionKey: unbindThreadBindingsBySessionKey,
    },
    typing: {
      pulse: sendTypingDiscordLazy,
      start: async ({ channelId, accountId, cfg, intervalMs }) =>
        await createDiscordTypingLease({
          channelId,
          accountId,
          cfg,
          intervalMs,
          pulse: async ({ channelId, accountId, cfg }) =>
            void (await sendTypingDiscordLazy(channelId, { accountId, cfg })),
        }),
    },
    conversationActions: {
      editMessage: editMessageDiscordLazy,
      deleteMessage: deleteMessageDiscordLazy,
      pinMessage: pinMessageDiscordLazy,
      unpinMessage: unpinMessageDiscordLazy,
      createThread: createThreadDiscordLazy,
      editChannel: editChannelDiscordLazy,
    },
  };
}
