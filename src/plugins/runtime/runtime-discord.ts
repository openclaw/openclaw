import {
  discordMessageActions,
  getThreadBindingManager,
  resolveThreadBindingIdleTimeoutMs,
  resolveThreadBindingInactivityExpiresAt,
  resolveThreadBindingMaxAgeExpiresAt,
  resolveThreadBindingMaxAgeMs,
  setThreadBindingIdleTimeoutBySessionKey,
  setThreadBindingMaxAgeBySessionKey,
  unbindThreadBindingsBySessionKey,
} from "../../../extensions/discord/runtime-api.js";
import {
  createLazyRuntimeMethodBinder,
  createLazyRuntimeSurface,
} from "../../shared/lazy-runtime.js";
import { createDiscordTypingLease } from "./runtime-discord-typing.js";
import type { PluginRuntimeChannel } from "./types-channel.js";

const loadRuntimeDiscordOps = createLazyRuntimeSurface(
  () => import("./runtime-discord-ops.runtime.js"),
  ({ runtimeDiscordOps }) => runtimeDiscordOps,
);

const bindDiscordRuntimeMethod = createLazyRuntimeMethodBinder(loadRuntimeDiscordOps);

const auditChannelPermissionsLazy = bindDiscordRuntimeMethod(
  (runtimeDiscordOps) => runtimeDiscordOps.auditChannelPermissions,
);
const listDirectoryGroupsLiveLazy = bindDiscordRuntimeMethod(
  (runtimeDiscordOps) => runtimeDiscordOps.listDirectoryGroupsLive,
);
const listDirectoryPeersLiveLazy = bindDiscordRuntimeMethod(
  (runtimeDiscordOps) => runtimeDiscordOps.listDirectoryPeersLive,
);
const probeDiscordLazy = bindDiscordRuntimeMethod(
  (runtimeDiscordOps) => runtimeDiscordOps.probeDiscord,
);
const resolveChannelAllowlistLazy = bindDiscordRuntimeMethod(
  (runtimeDiscordOps) => runtimeDiscordOps.resolveChannelAllowlist,
);
const resolveUserAllowlistLazy = bindDiscordRuntimeMethod(
  (runtimeDiscordOps) => runtimeDiscordOps.resolveUserAllowlist,
);
const sendComponentMessageLazy = bindDiscordRuntimeMethod(
  (runtimeDiscordOps) => runtimeDiscordOps.sendComponentMessage,
);
const sendMessageDiscordLazy = bindDiscordRuntimeMethod(
  (runtimeDiscordOps) => runtimeDiscordOps.sendMessageDiscord,
);
const sendPollDiscordLazy = bindDiscordRuntimeMethod(
  (runtimeDiscordOps) => runtimeDiscordOps.sendPollDiscord,
);
const monitorDiscordProviderLazy = bindDiscordRuntimeMethod(
  (runtimeDiscordOps) => runtimeDiscordOps.monitorDiscordProvider,
);
const sendTypingDiscordLazy = bindDiscordRuntimeMethod(
  (runtimeDiscordOps) => runtimeDiscordOps.typing.pulse,
);
const editMessageDiscordLazy = bindDiscordRuntimeMethod(
  (runtimeDiscordOps) => runtimeDiscordOps.conversationActions.editMessage,
);
const deleteMessageDiscordLazy = bindDiscordRuntimeMethod(
  (runtimeDiscordOps) => runtimeDiscordOps.conversationActions.deleteMessage,
);
const pinMessageDiscordLazy = bindDiscordRuntimeMethod(
  (runtimeDiscordOps) => runtimeDiscordOps.conversationActions.pinMessage,
);
const unpinMessageDiscordLazy = bindDiscordRuntimeMethod(
  (runtimeDiscordOps) => runtimeDiscordOps.conversationActions.unpinMessage,
);
const createThreadDiscordLazy = bindDiscordRuntimeMethod(
  (runtimeDiscordOps) => runtimeDiscordOps.conversationActions.createThread,
);
const editChannelDiscordLazy = bindDiscordRuntimeMethod(
  (runtimeDiscordOps) => runtimeDiscordOps.conversationActions.editChannel,
);

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
