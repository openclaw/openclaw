import {
  auditDiscordChannelPermissions as auditDiscordChannelPermissionsImpl,
  listDiscordDirectoryGroupsLive as listDiscordDirectoryGroupsLiveImpl,
  listDiscordDirectoryPeersLive as listDiscordDirectoryPeersLiveImpl,
  monitorDiscordProvider as monitorDiscordProviderImpl,
  probeDiscord as probeDiscordImpl,
  resolveDiscordChannelAllowlist as resolveDiscordChannelAllowlistImpl,
  resolveDiscordUserAllowlist as resolveDiscordUserAllowlistImpl,
} from "../../../extensions/discord/runtime-api.js";
import {
  createThreadDiscord as createThreadDiscordImpl,
  deleteMessageDiscord as deleteMessageDiscordImpl,
  editChannelDiscord as editChannelDiscordImpl,
  editMessageDiscord as editMessageDiscordImpl,
  pinMessageDiscord as pinMessageDiscordImpl,
  sendDiscordComponentMessage as sendDiscordComponentMessageImpl,
  sendMessageDiscord as sendMessageDiscordImpl,
  sendPollDiscord as sendPollDiscordImpl,
  sendTypingDiscord as sendTypingDiscordImpl,
  unpinMessageDiscord as unpinMessageDiscordImpl,
} from "../../../extensions/discord/runtime-api.js";
import type { PluginRuntimeChannel } from "./types-channel.js";

type RuntimeDiscordOps = Pick<
  PluginRuntimeChannel["discord"],
  | "auditChannelPermissions"
  | "listDirectoryGroupsLive"
  | "listDirectoryPeersLive"
  | "probeDiscord"
  | "resolveChannelAllowlist"
  | "resolveUserAllowlist"
  | "sendComponentMessage"
  | "sendMessageDiscord"
  | "sendPollDiscord"
  | "monitorDiscordProvider"
> & {
  typing: Pick<PluginRuntimeChannel["discord"]["typing"], "pulse">;
  conversationActions: Pick<
    PluginRuntimeChannel["discord"]["conversationActions"],
    "editMessage" | "deleteMessage" | "pinMessage" | "unpinMessage" | "createThread" | "editChannel"
  >;
};

export const runtimeDiscordOps = {
  auditChannelPermissions: auditDiscordChannelPermissionsImpl,
  listDirectoryGroupsLive: listDiscordDirectoryGroupsLiveImpl,
  listDirectoryPeersLive: listDiscordDirectoryPeersLiveImpl,
  probeDiscord: probeDiscordImpl,
  resolveChannelAllowlist: resolveDiscordChannelAllowlistImpl,
  resolveUserAllowlist: resolveDiscordUserAllowlistImpl,
  sendComponentMessage: sendDiscordComponentMessageImpl,
  sendMessageDiscord: sendMessageDiscordImpl,
  sendPollDiscord: sendPollDiscordImpl,
  monitorDiscordProvider: monitorDiscordProviderImpl,
  typing: {
    pulse: sendTypingDiscordImpl,
  },
  conversationActions: {
    editMessage: editMessageDiscordImpl,
    deleteMessage: deleteMessageDiscordImpl,
    pinMessage: pinMessageDiscordImpl,
    unpinMessage: unpinMessageDiscordImpl,
    createThread: createThreadDiscordImpl,
    editChannel: editChannelDiscordImpl,
  },
} satisfies RuntimeDiscordOps;
