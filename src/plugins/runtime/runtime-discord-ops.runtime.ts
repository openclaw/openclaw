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

type AuditDiscordChannelPermissions =
  typeof import("../../../extensions/discord/src/audit.js").auditDiscordChannelPermissions;
type ListDiscordDirectoryGroupsLive =
  typeof import("../../../extensions/discord/src/directory-live.js").listDiscordDirectoryGroupsLive;
type ListDiscordDirectoryPeersLive =
  typeof import("../../../extensions/discord/src/directory-live.js").listDiscordDirectoryPeersLive;
type MonitorDiscordProvider =
  typeof import("../../../extensions/discord/src/monitor.js").monitorDiscordProvider;
type ProbeDiscord = typeof import("../../../extensions/discord/src/probe.js").probeDiscord;
type ResolveDiscordChannelAllowlist =
  typeof import("../../../extensions/discord/src/resolve-channels.js").resolveDiscordChannelAllowlist;
type ResolveDiscordUserAllowlist =
  typeof import("../../../extensions/discord/src/resolve-users.js").resolveDiscordUserAllowlist;
type CreateThreadDiscord =
  typeof import("../../../extensions/discord/src/send.js").createThreadDiscord;
type DeleteMessageDiscord =
  typeof import("../../../extensions/discord/src/send.js").deleteMessageDiscord;
type EditChannelDiscord =
  typeof import("../../../extensions/discord/src/send.js").editChannelDiscord;
type EditMessageDiscord =
  typeof import("../../../extensions/discord/src/send.js").editMessageDiscord;
type PinMessageDiscord = typeof import("../../../extensions/discord/src/send.js").pinMessageDiscord;
type SendDiscordComponentMessage =
  typeof import("../../../extensions/discord/src/send.js").sendDiscordComponentMessage;
type SendMessageDiscord =
  typeof import("../../../extensions/discord/src/send.js").sendMessageDiscord;
type SendPollDiscord = typeof import("../../../extensions/discord/src/send.js").sendPollDiscord;
type SendTypingDiscord = typeof import("../../../extensions/discord/src/send.js").sendTypingDiscord;
type UnpinMessageDiscord =
  typeof import("../../../extensions/discord/src/send.js").unpinMessageDiscord;

export function auditDiscordChannelPermissions(
  ...args: Parameters<AuditDiscordChannelPermissions>
): ReturnType<AuditDiscordChannelPermissions> {
  return auditDiscordChannelPermissionsImpl(...args);
}

export function listDiscordDirectoryGroupsLive(
  ...args: Parameters<ListDiscordDirectoryGroupsLive>
): ReturnType<ListDiscordDirectoryGroupsLive> {
  return listDiscordDirectoryGroupsLiveImpl(...args);
}

export function listDiscordDirectoryPeersLive(
  ...args: Parameters<ListDiscordDirectoryPeersLive>
): ReturnType<ListDiscordDirectoryPeersLive> {
  return listDiscordDirectoryPeersLiveImpl(...args);
}

export function monitorDiscordProvider(
  ...args: Parameters<MonitorDiscordProvider>
): ReturnType<MonitorDiscordProvider> {
  return monitorDiscordProviderImpl(...args);
}

export function probeDiscord(...args: Parameters<ProbeDiscord>): ReturnType<ProbeDiscord> {
  return probeDiscordImpl(...args);
}

export function resolveDiscordChannelAllowlist(
  ...args: Parameters<ResolveDiscordChannelAllowlist>
): ReturnType<ResolveDiscordChannelAllowlist> {
  return resolveDiscordChannelAllowlistImpl(...args);
}

export function resolveDiscordUserAllowlist(
  ...args: Parameters<ResolveDiscordUserAllowlist>
): ReturnType<ResolveDiscordUserAllowlist> {
  return resolveDiscordUserAllowlistImpl(...args);
}

export function createThreadDiscord(
  ...args: Parameters<CreateThreadDiscord>
): ReturnType<CreateThreadDiscord> {
  return createThreadDiscordImpl(...args);
}

export function deleteMessageDiscord(
  ...args: Parameters<DeleteMessageDiscord>
): ReturnType<DeleteMessageDiscord> {
  return deleteMessageDiscordImpl(...args);
}

export function editChannelDiscord(
  ...args: Parameters<EditChannelDiscord>
): ReturnType<EditChannelDiscord> {
  return editChannelDiscordImpl(...args);
}

export function editMessageDiscord(
  ...args: Parameters<EditMessageDiscord>
): ReturnType<EditMessageDiscord> {
  return editMessageDiscordImpl(...args);
}

export function pinMessageDiscord(
  ...args: Parameters<PinMessageDiscord>
): ReturnType<PinMessageDiscord> {
  return pinMessageDiscordImpl(...args);
}

export function sendDiscordComponentMessage(
  ...args: Parameters<SendDiscordComponentMessage>
): ReturnType<SendDiscordComponentMessage> {
  return sendDiscordComponentMessageImpl(...args);
}

export function sendMessageDiscord(
  ...args: Parameters<SendMessageDiscord>
): ReturnType<SendMessageDiscord> {
  return sendMessageDiscordImpl(...args);
}

export function sendPollDiscord(...args: Parameters<SendPollDiscord>): ReturnType<SendPollDiscord> {
  return sendPollDiscordImpl(...args);
}

export function sendTypingDiscord(
  ...args: Parameters<SendTypingDiscord>
): ReturnType<SendTypingDiscord> {
  return sendTypingDiscordImpl(...args);
}

export function unpinMessageDiscord(
  ...args: Parameters<UnpinMessageDiscord>
): ReturnType<UnpinMessageDiscord> {
  return unpinMessageDiscordImpl(...args);
}
