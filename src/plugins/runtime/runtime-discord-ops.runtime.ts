import { auditDiscordChannelPermissions as auditDiscordChannelPermissionsImpl } from "../../../extensions/discord/src/audit.js";
import {
  listDiscordDirectoryGroupsLive as listDiscordDirectoryGroupsLiveImpl,
  listDiscordDirectoryPeersLive as listDiscordDirectoryPeersLiveImpl,
} from "../../../extensions/discord/src/directory-live.js";
import { monitorDiscordProvider as monitorDiscordProviderImpl } from "../../../extensions/discord/src/monitor.js";
import { probeDiscord as probeDiscordImpl } from "../../../extensions/discord/src/probe.js";
import { resolveDiscordChannelAllowlist as resolveDiscordChannelAllowlistImpl } from "../../../extensions/discord/src/resolve-channels.js";
import { resolveDiscordUserAllowlist as resolveDiscordUserAllowlistImpl } from "../../../extensions/discord/src/resolve-users.js";
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
} from "../../../extensions/discord/src/send.js";
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
