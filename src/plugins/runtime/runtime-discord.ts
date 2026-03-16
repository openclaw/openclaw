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

let runtimeDiscordOpsPromise: Promise<typeof import("./runtime-discord-ops.runtime.js")> | null =
  null;

function loadRuntimeDiscordOps() {
  runtimeDiscordOpsPromise ??= import("./runtime-discord-ops.runtime.js");
  return runtimeDiscordOpsPromise;
}

const auditChannelPermissionsLazy: PluginRuntimeChannel["discord"]["auditChannelPermissions"] =
  async (...args) => {
    const { auditDiscordChannelPermissions } = await loadRuntimeDiscordOps();
    return auditDiscordChannelPermissions(...args);
  };

const listDirectoryGroupsLiveLazy: PluginRuntimeChannel["discord"]["listDirectoryGroupsLive"] =
  async (...args) => {
    const { listDiscordDirectoryGroupsLive } = await loadRuntimeDiscordOps();
    return listDiscordDirectoryGroupsLive(...args);
  };

const listDirectoryPeersLiveLazy: PluginRuntimeChannel["discord"]["listDirectoryPeersLive"] =
  async (...args) => {
    const { listDiscordDirectoryPeersLive } = await loadRuntimeDiscordOps();
    return listDiscordDirectoryPeersLive(...args);
  };

const probeDiscordLazy: PluginRuntimeChannel["discord"]["probeDiscord"] = async (...args) => {
  const { probeDiscord } = await loadRuntimeDiscordOps();
  return probeDiscord(...args);
};

const resolveChannelAllowlistLazy: PluginRuntimeChannel["discord"]["resolveChannelAllowlist"] =
  async (...args) => {
    const { resolveDiscordChannelAllowlist } = await loadRuntimeDiscordOps();
    return resolveDiscordChannelAllowlist(...args);
  };

const resolveUserAllowlistLazy: PluginRuntimeChannel["discord"]["resolveUserAllowlist"] = async (
  ...args
) => {
  const { resolveDiscordUserAllowlist } = await loadRuntimeDiscordOps();
  return resolveDiscordUserAllowlist(...args);
};

const sendComponentMessageLazy: PluginRuntimeChannel["discord"]["sendComponentMessage"] = async (
  ...args
) => {
  const { sendDiscordComponentMessage } = await loadRuntimeDiscordOps();
  return sendDiscordComponentMessage(...args);
};

const sendMessageDiscordLazy: PluginRuntimeChannel["discord"]["sendMessageDiscord"] = async (
  ...args
) => {
  const { sendMessageDiscord } = await loadRuntimeDiscordOps();
  return sendMessageDiscord(...args);
};

const sendPollDiscordLazy: PluginRuntimeChannel["discord"]["sendPollDiscord"] = async (...args) => {
  const { sendPollDiscord } = await loadRuntimeDiscordOps();
  return sendPollDiscord(...args);
};

const monitorDiscordProviderLazy: PluginRuntimeChannel["discord"]["monitorDiscordProvider"] =
  async (...args) => {
    const { monitorDiscordProvider } = await loadRuntimeDiscordOps();
    return monitorDiscordProvider(...args);
  };

const sendTypingDiscordLazy: PluginRuntimeChannel["discord"]["typing"]["pulse"] = async (
  ...args
) => {
  const { sendTypingDiscord } = await loadRuntimeDiscordOps();
  return sendTypingDiscord(...args);
};

const editMessageDiscordLazy: PluginRuntimeChannel["discord"]["conversationActions"]["editMessage"] =
  async (...args) => {
    const { editMessageDiscord } = await loadRuntimeDiscordOps();
    return editMessageDiscord(...args);
  };

const deleteMessageDiscordLazy: PluginRuntimeChannel["discord"]["conversationActions"]["deleteMessage"] =
  async (...args) => {
    const { deleteMessageDiscord } = await loadRuntimeDiscordOps();
    return deleteMessageDiscord(...args);
  };

const pinMessageDiscordLazy: PluginRuntimeChannel["discord"]["conversationActions"]["pinMessage"] =
  async (...args) => {
    const { pinMessageDiscord } = await loadRuntimeDiscordOps();
    return pinMessageDiscord(...args);
  };

const unpinMessageDiscordLazy: PluginRuntimeChannel["discord"]["conversationActions"]["unpinMessage"] =
  async (...args) => {
    const { unpinMessageDiscord } = await loadRuntimeDiscordOps();
    return unpinMessageDiscord(...args);
  };

const createThreadDiscordLazy: PluginRuntimeChannel["discord"]["conversationActions"]["createThread"] =
  async (...args) => {
    const { createThreadDiscord } = await loadRuntimeDiscordOps();
    return createThreadDiscord(...args);
  };

const editChannelDiscordLazy: PluginRuntimeChannel["discord"]["conversationActions"]["editChannel"] =
  async (...args) => {
    const { editChannelDiscord } = await loadRuntimeDiscordOps();
    return editChannelDiscord(...args);
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
