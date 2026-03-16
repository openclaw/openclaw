import { auditDiscordChannelPermissions } from "../../../extensions/discord/src/audit.js";
import { discordMessageActions } from "../../../extensions/discord/src/channel-actions.js";
import {
  listDiscordDirectoryGroupsLive,
  listDiscordDirectoryPeersLive,
} from "../../../extensions/discord/src/directory-live.js";
import { monitorDiscordProvider } from "../../../extensions/discord/src/monitor.js";
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
import { probeDiscord } from "../../../extensions/discord/src/probe.js";
import { resolveDiscordChannelAllowlist } from "../../../extensions/discord/src/resolve-channels.js";
import { resolveDiscordUserAllowlist } from "../../../extensions/discord/src/resolve-users.js";
import {
  createThreadDiscord,
  deleteMessageDiscord,
  editChannelDiscord,
  editMessageDiscord,
  pinMessageDiscord,
  sendDiscordComponentMessage,
  sendMessageDiscord,
  sendPollDiscord,
  sendTypingDiscord,
  unpinMessageDiscord,
} from "../../../extensions/discord/src/send.js";
import { createDiscordTypingLease } from "./runtime-discord-typing.js";
import type { PluginRuntimeChannel } from "./types-channel.js";

export function createRuntimeDiscord(): PluginRuntimeChannel["discord"] {
  return {
    messageActions: discordMessageActions,
    auditChannelPermissions: auditDiscordChannelPermissions,
    listDirectoryGroupsLive: listDiscordDirectoryGroupsLive,
    listDirectoryPeersLive: listDiscordDirectoryPeersLive,
    probeDiscord,
    resolveChannelAllowlist: resolveDiscordChannelAllowlist,
    resolveUserAllowlist: resolveDiscordUserAllowlist,
    sendComponentMessage: sendDiscordComponentMessage,
    sendMessageDiscord,
    sendPollDiscord,
    monitorDiscordProvider,
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
      pulse: sendTypingDiscord,
      start: async ({ channelId, accountId, cfg, intervalMs }) =>
        await createDiscordTypingLease({
          channelId,
          accountId,
          cfg,
          intervalMs,
          pulse: async ({ channelId, accountId, cfg }) =>
            void (await sendTypingDiscord(channelId, { accountId, cfg })),
        }),
    },
    conversationActions: {
      editMessage: editMessageDiscord,
      deleteMessage: deleteMessageDiscord,
      pinMessage: pinMessageDiscord,
      unpinMessage: unpinMessageDiscord,
      createThread: createThreadDiscord,
      editChannel: editChannelDiscord,
    },
  };
}
