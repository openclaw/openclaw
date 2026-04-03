import {
  createLazyFacadeObjectValue,
  loadBundledPluginPublicSurfaceModuleSync,
} from "./facade-runtime.js";

type DiscordRuntimeModule = typeof import("../../extensions/discord/runtime-api.js");

type DiscordRuntimeSurface = Pick<
  DiscordRuntimeModule,
  | "auditDiscordChannelPermissions"
  | "createThreadDiscord"
  | "deleteMessageDiscord"
  | "discordMessageActions"
  | "editChannelDiscord"
  | "editMessageDiscord"
  | "getThreadBindingManager"
  | "listDiscordDirectoryGroupsLive"
  | "listDiscordDirectoryPeersLive"
  | "monitorDiscordProvider"
  | "pinMessageDiscord"
  | "probeDiscord"
  | "resolveDiscordChannelAllowlist"
  | "resolveDiscordUserAllowlist"
  | "resolveThreadBindingIdleTimeoutMs"
  | "resolveThreadBindingInactivityExpiresAt"
  | "resolveThreadBindingMaxAgeExpiresAt"
  | "resolveThreadBindingMaxAgeMs"
  | "sendDiscordComponentMessage"
  | "sendMessageDiscord"
  | "sendPollDiscord"
  | "sendTypingDiscord"
  | "setThreadBindingIdleTimeoutBySessionKey"
  | "setThreadBindingMaxAgeBySessionKey"
  | "unbindThreadBindingsBySessionKey"
  | "unpinMessageDiscord"
>;

function loadDiscordRuntimeSurface(): DiscordRuntimeSurface {
  return loadBundledPluginPublicSurfaceModuleSync<DiscordRuntimeSurface>({
    dirName: "discord",
    artifactBasename: "runtime-api.js",
  });
}

export const discordMessageActions: DiscordRuntimeModule["discordMessageActions"] =
  createLazyFacadeObjectValue(() => loadDiscordRuntimeSurface().discordMessageActions);

export const auditDiscordChannelPermissions: DiscordRuntimeModule["auditDiscordChannelPermissions"] =
  ((...args) =>
    loadDiscordRuntimeSurface().auditDiscordChannelPermissions(
      ...args,
    )) as DiscordRuntimeModule["auditDiscordChannelPermissions"];

export const createThreadDiscord: DiscordRuntimeModule["createThreadDiscord"] = ((...args) =>
  loadDiscordRuntimeSurface().createThreadDiscord(
    ...args,
  )) as DiscordRuntimeModule["createThreadDiscord"];

export const deleteMessageDiscord: DiscordRuntimeModule["deleteMessageDiscord"] = ((...args) =>
  loadDiscordRuntimeSurface().deleteMessageDiscord(
    ...args,
  )) as DiscordRuntimeModule["deleteMessageDiscord"];

export const editChannelDiscord: DiscordRuntimeModule["editChannelDiscord"] = ((...args) =>
  loadDiscordRuntimeSurface().editChannelDiscord(
    ...args,
  )) as DiscordRuntimeModule["editChannelDiscord"];

export const editMessageDiscord: DiscordRuntimeModule["editMessageDiscord"] = ((...args) =>
  loadDiscordRuntimeSurface().editMessageDiscord(
    ...args,
  )) as DiscordRuntimeModule["editMessageDiscord"];

export const getThreadBindingManager: DiscordRuntimeModule["getThreadBindingManager"] = ((
  ...args
) =>
  loadDiscordRuntimeSurface().getThreadBindingManager(
    ...args,
  )) as DiscordRuntimeModule["getThreadBindingManager"];

export const listDiscordDirectoryGroupsLive: DiscordRuntimeModule["listDiscordDirectoryGroupsLive"] =
  ((...args) =>
    loadDiscordRuntimeSurface().listDiscordDirectoryGroupsLive(
      ...args,
    )) as DiscordRuntimeModule["listDiscordDirectoryGroupsLive"];

export const listDiscordDirectoryPeersLive: DiscordRuntimeModule["listDiscordDirectoryPeersLive"] =
  ((...args) =>
    loadDiscordRuntimeSurface().listDiscordDirectoryPeersLive(
      ...args,
    )) as DiscordRuntimeModule["listDiscordDirectoryPeersLive"];

export const monitorDiscordProvider: DiscordRuntimeModule["monitorDiscordProvider"] = ((...args) =>
  loadDiscordRuntimeSurface().monitorDiscordProvider(
    ...args,
  )) as DiscordRuntimeModule["monitorDiscordProvider"];

export const pinMessageDiscord: DiscordRuntimeModule["pinMessageDiscord"] = ((...args) =>
  loadDiscordRuntimeSurface().pinMessageDiscord(
    ...args,
  )) as DiscordRuntimeModule["pinMessageDiscord"];

export const probeDiscord: DiscordRuntimeModule["probeDiscord"] = ((...args) =>
  loadDiscordRuntimeSurface().probeDiscord(...args)) as DiscordRuntimeModule["probeDiscord"];

export const resolveDiscordChannelAllowlist: DiscordRuntimeModule["resolveDiscordChannelAllowlist"] =
  ((...args) =>
    loadDiscordRuntimeSurface().resolveDiscordChannelAllowlist(
      ...args,
    )) as DiscordRuntimeModule["resolveDiscordChannelAllowlist"];

export const resolveDiscordUserAllowlist: DiscordRuntimeModule["resolveDiscordUserAllowlist"] = ((
  ...args
) =>
  loadDiscordRuntimeSurface().resolveDiscordUserAllowlist(
    ...args,
  )) as DiscordRuntimeModule["resolveDiscordUserAllowlist"];

export const resolveThreadBindingIdleTimeoutMs: DiscordRuntimeModule["resolveThreadBindingIdleTimeoutMs"] =
  ((...args) =>
    loadDiscordRuntimeSurface().resolveThreadBindingIdleTimeoutMs(
      ...args,
    )) as DiscordRuntimeModule["resolveThreadBindingIdleTimeoutMs"];

export const resolveThreadBindingInactivityExpiresAt: DiscordRuntimeModule["resolveThreadBindingInactivityExpiresAt"] =
  ((...args) =>
    loadDiscordRuntimeSurface().resolveThreadBindingInactivityExpiresAt(
      ...args,
    )) as DiscordRuntimeModule["resolveThreadBindingInactivityExpiresAt"];

export const resolveThreadBindingMaxAgeExpiresAt: DiscordRuntimeModule["resolveThreadBindingMaxAgeExpiresAt"] =
  ((...args) =>
    loadDiscordRuntimeSurface().resolveThreadBindingMaxAgeExpiresAt(
      ...args,
    )) as DiscordRuntimeModule["resolveThreadBindingMaxAgeExpiresAt"];

export const resolveThreadBindingMaxAgeMs: DiscordRuntimeModule["resolveThreadBindingMaxAgeMs"] = ((
  ...args
) =>
  loadDiscordRuntimeSurface().resolveThreadBindingMaxAgeMs(
    ...args,
  )) as DiscordRuntimeModule["resolveThreadBindingMaxAgeMs"];

export const sendDiscordComponentMessage: DiscordRuntimeModule["sendDiscordComponentMessage"] = ((
  ...args
) =>
  loadDiscordRuntimeSurface().sendDiscordComponentMessage(
    ...args,
  )) as DiscordRuntimeModule["sendDiscordComponentMessage"];

export const sendMessageDiscord: DiscordRuntimeModule["sendMessageDiscord"] = ((...args) =>
  loadDiscordRuntimeSurface().sendMessageDiscord(
    ...args,
  )) as DiscordRuntimeModule["sendMessageDiscord"];

export const sendPollDiscord: DiscordRuntimeModule["sendPollDiscord"] = ((...args) =>
  loadDiscordRuntimeSurface().sendPollDiscord(...args)) as DiscordRuntimeModule["sendPollDiscord"];

export const sendTypingDiscord: DiscordRuntimeModule["sendTypingDiscord"] = ((...args) =>
  loadDiscordRuntimeSurface().sendTypingDiscord(
    ...args,
  )) as DiscordRuntimeModule["sendTypingDiscord"];

export const setThreadBindingIdleTimeoutBySessionKey: DiscordRuntimeModule["setThreadBindingIdleTimeoutBySessionKey"] =
  ((...args) =>
    loadDiscordRuntimeSurface().setThreadBindingIdleTimeoutBySessionKey(
      ...args,
    )) as DiscordRuntimeModule["setThreadBindingIdleTimeoutBySessionKey"];

export const setThreadBindingMaxAgeBySessionKey: DiscordRuntimeModule["setThreadBindingMaxAgeBySessionKey"] =
  ((...args) =>
    loadDiscordRuntimeSurface().setThreadBindingMaxAgeBySessionKey(
      ...args,
    )) as DiscordRuntimeModule["setThreadBindingMaxAgeBySessionKey"];

export const unbindThreadBindingsBySessionKey: DiscordRuntimeModule["unbindThreadBindingsBySessionKey"] =
  ((...args) =>
    loadDiscordRuntimeSurface().unbindThreadBindingsBySessionKey(
      ...args,
    )) as DiscordRuntimeModule["unbindThreadBindingsBySessionKey"];

export const unpinMessageDiscord: DiscordRuntimeModule["unpinMessageDiscord"] = ((...args) =>
  loadDiscordRuntimeSurface().unpinMessageDiscord(
    ...args,
  )) as DiscordRuntimeModule["unpinMessageDiscord"];
