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
import { createLazyRuntimeMethod, createLazyRuntimeSurface } from "../../shared/lazy-runtime.js";
import { createDiscordTypingLease } from "./runtime-discord-typing.js";
import type { PluginRuntimeChannel } from "./types-channel.js";

type RuntimeDiscordOps = typeof import("./runtime-discord-ops.runtime.js").runtimeDiscordOps;

const loadRuntimeDiscordOps = createLazyRuntimeSurface(
  () => import("./runtime-discord-ops.runtime.js"),
  ({ runtimeDiscordOps }) => runtimeDiscordOps,
);

const auditChannelPermissionsLazy = createLazyRuntimeMethod<
  RuntimeDiscordOps,
  Parameters<PluginRuntimeChannel["discord"]["auditChannelPermissions"]>,
  ReturnType<PluginRuntimeChannel["discord"]["auditChannelPermissions"]>
>(loadRuntimeDiscordOps, (runtimeDiscordOps) => runtimeDiscordOps.auditChannelPermissions);

const listDirectoryGroupsLiveLazy = createLazyRuntimeMethod<
  RuntimeDiscordOps,
  Parameters<PluginRuntimeChannel["discord"]["listDirectoryGroupsLive"]>,
  ReturnType<PluginRuntimeChannel["discord"]["listDirectoryGroupsLive"]>
>(loadRuntimeDiscordOps, (runtimeDiscordOps) => runtimeDiscordOps.listDirectoryGroupsLive);

const listDirectoryPeersLiveLazy = createLazyRuntimeMethod<
  RuntimeDiscordOps,
  Parameters<PluginRuntimeChannel["discord"]["listDirectoryPeersLive"]>,
  ReturnType<PluginRuntimeChannel["discord"]["listDirectoryPeersLive"]>
>(loadRuntimeDiscordOps, (runtimeDiscordOps) => runtimeDiscordOps.listDirectoryPeersLive);

const probeDiscordLazy = createLazyRuntimeMethod<
  RuntimeDiscordOps,
  Parameters<PluginRuntimeChannel["discord"]["probeDiscord"]>,
  ReturnType<PluginRuntimeChannel["discord"]["probeDiscord"]>
>(loadRuntimeDiscordOps, (runtimeDiscordOps) => runtimeDiscordOps.probeDiscord);

const resolveChannelAllowlistLazy = createLazyRuntimeMethod<
  RuntimeDiscordOps,
  Parameters<PluginRuntimeChannel["discord"]["resolveChannelAllowlist"]>,
  ReturnType<PluginRuntimeChannel["discord"]["resolveChannelAllowlist"]>
>(loadRuntimeDiscordOps, (runtimeDiscordOps) => runtimeDiscordOps.resolveChannelAllowlist);

const resolveUserAllowlistLazy = createLazyRuntimeMethod<
  RuntimeDiscordOps,
  Parameters<PluginRuntimeChannel["discord"]["resolveUserAllowlist"]>,
  ReturnType<PluginRuntimeChannel["discord"]["resolveUserAllowlist"]>
>(loadRuntimeDiscordOps, (runtimeDiscordOps) => runtimeDiscordOps.resolveUserAllowlist);

const sendComponentMessageLazy = createLazyRuntimeMethod<
  RuntimeDiscordOps,
  Parameters<PluginRuntimeChannel["discord"]["sendComponentMessage"]>,
  ReturnType<PluginRuntimeChannel["discord"]["sendComponentMessage"]>
>(loadRuntimeDiscordOps, (runtimeDiscordOps) => runtimeDiscordOps.sendComponentMessage);

const sendMessageDiscordLazy = createLazyRuntimeMethod<
  RuntimeDiscordOps,
  Parameters<PluginRuntimeChannel["discord"]["sendMessageDiscord"]>,
  ReturnType<PluginRuntimeChannel["discord"]["sendMessageDiscord"]>
>(loadRuntimeDiscordOps, (runtimeDiscordOps) => runtimeDiscordOps.sendMessageDiscord);

const sendPollDiscordLazy = createLazyRuntimeMethod<
  RuntimeDiscordOps,
  Parameters<PluginRuntimeChannel["discord"]["sendPollDiscord"]>,
  ReturnType<PluginRuntimeChannel["discord"]["sendPollDiscord"]>
>(loadRuntimeDiscordOps, (runtimeDiscordOps) => runtimeDiscordOps.sendPollDiscord);

const monitorDiscordProviderLazy = createLazyRuntimeMethod<
  RuntimeDiscordOps,
  Parameters<PluginRuntimeChannel["discord"]["monitorDiscordProvider"]>,
  ReturnType<PluginRuntimeChannel["discord"]["monitorDiscordProvider"]>
>(loadRuntimeDiscordOps, (runtimeDiscordOps) => runtimeDiscordOps.monitorDiscordProvider);

const sendTypingDiscordLazy = createLazyRuntimeMethod<
  RuntimeDiscordOps,
  Parameters<PluginRuntimeChannel["discord"]["typing"]["pulse"]>,
  ReturnType<PluginRuntimeChannel["discord"]["typing"]["pulse"]>
>(loadRuntimeDiscordOps, (runtimeDiscordOps) => runtimeDiscordOps.typing.pulse);

const editMessageDiscordLazy = createLazyRuntimeMethod<
  RuntimeDiscordOps,
  Parameters<PluginRuntimeChannel["discord"]["conversationActions"]["editMessage"]>,
  ReturnType<PluginRuntimeChannel["discord"]["conversationActions"]["editMessage"]>
>(loadRuntimeDiscordOps, (runtimeDiscordOps) => runtimeDiscordOps.conversationActions.editMessage);

const deleteMessageDiscordLazy = createLazyRuntimeMethod<
  RuntimeDiscordOps,
  Parameters<PluginRuntimeChannel["discord"]["conversationActions"]["deleteMessage"]>,
  ReturnType<PluginRuntimeChannel["discord"]["conversationActions"]["deleteMessage"]>
>(
  loadRuntimeDiscordOps,
  (runtimeDiscordOps) => runtimeDiscordOps.conversationActions.deleteMessage,
);

const pinMessageDiscordLazy = createLazyRuntimeMethod<
  RuntimeDiscordOps,
  Parameters<PluginRuntimeChannel["discord"]["conversationActions"]["pinMessage"]>,
  ReturnType<PluginRuntimeChannel["discord"]["conversationActions"]["pinMessage"]>
>(loadRuntimeDiscordOps, (runtimeDiscordOps) => runtimeDiscordOps.conversationActions.pinMessage);

const unpinMessageDiscordLazy = createLazyRuntimeMethod<
  RuntimeDiscordOps,
  Parameters<PluginRuntimeChannel["discord"]["conversationActions"]["unpinMessage"]>,
  ReturnType<PluginRuntimeChannel["discord"]["conversationActions"]["unpinMessage"]>
>(loadRuntimeDiscordOps, (runtimeDiscordOps) => runtimeDiscordOps.conversationActions.unpinMessage);

const createThreadDiscordLazy = createLazyRuntimeMethod<
  RuntimeDiscordOps,
  Parameters<PluginRuntimeChannel["discord"]["conversationActions"]["createThread"]>,
  ReturnType<PluginRuntimeChannel["discord"]["conversationActions"]["createThread"]>
>(loadRuntimeDiscordOps, (runtimeDiscordOps) => runtimeDiscordOps.conversationActions.createThread);

const editChannelDiscordLazy = createLazyRuntimeMethod<
  RuntimeDiscordOps,
  Parameters<PluginRuntimeChannel["discord"]["conversationActions"]["editChannel"]>,
  ReturnType<PluginRuntimeChannel["discord"]["conversationActions"]["editChannel"]>
>(loadRuntimeDiscordOps, (runtimeDiscordOps) => runtimeDiscordOps.conversationActions.editChannel);

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
