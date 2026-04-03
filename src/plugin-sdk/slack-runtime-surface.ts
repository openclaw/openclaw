import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";

type SlackRuntimeModule = typeof import("../../extensions/slack/runtime-api.js");

type SlackRuntimeSurface = Pick<
  SlackRuntimeModule,
  | "handleSlackAction"
  | "listSlackDirectoryGroupsLive"
  | "listSlackDirectoryPeersLive"
  | "monitorSlackProvider"
  | "probeSlack"
  | "resolveSlackChannelAllowlist"
  | "resolveSlackUserAllowlist"
  | "sendMessageSlack"
>;

function loadSlackRuntimeSurface(): SlackRuntimeSurface {
  return loadBundledPluginPublicSurfaceModuleSync<SlackRuntimeSurface>({
    dirName: "slack",
    artifactBasename: "runtime-api.js",
  });
}

export const handleSlackAction: SlackRuntimeModule["handleSlackAction"] = ((...args) =>
  loadSlackRuntimeSurface().handleSlackAction(...args)) as SlackRuntimeModule["handleSlackAction"];

export const listSlackDirectoryGroupsLive: SlackRuntimeModule["listSlackDirectoryGroupsLive"] = ((
  ...args
) =>
  loadSlackRuntimeSurface().listSlackDirectoryGroupsLive(
    ...args,
  )) as SlackRuntimeModule["listSlackDirectoryGroupsLive"];

export const listSlackDirectoryPeersLive: SlackRuntimeModule["listSlackDirectoryPeersLive"] = ((
  ...args
) =>
  loadSlackRuntimeSurface().listSlackDirectoryPeersLive(
    ...args,
  )) as SlackRuntimeModule["listSlackDirectoryPeersLive"];

export const monitorSlackProvider: SlackRuntimeModule["monitorSlackProvider"] = ((...args) =>
  loadSlackRuntimeSurface().monitorSlackProvider(
    ...args,
  )) as SlackRuntimeModule["monitorSlackProvider"];

export const probeSlack: SlackRuntimeModule["probeSlack"] = ((...args) =>
  loadSlackRuntimeSurface().probeSlack(...args)) as SlackRuntimeModule["probeSlack"];

export const resolveSlackChannelAllowlist: SlackRuntimeModule["resolveSlackChannelAllowlist"] = ((
  ...args
) =>
  loadSlackRuntimeSurface().resolveSlackChannelAllowlist(
    ...args,
  )) as SlackRuntimeModule["resolveSlackChannelAllowlist"];

export const resolveSlackUserAllowlist: SlackRuntimeModule["resolveSlackUserAllowlist"] = ((
  ...args
) =>
  loadSlackRuntimeSurface().resolveSlackUserAllowlist(
    ...args,
  )) as SlackRuntimeModule["resolveSlackUserAllowlist"];

export const sendMessageSlack: SlackRuntimeModule["sendMessageSlack"] = ((...args) =>
  loadSlackRuntimeSurface().sendMessageSlack(...args)) as SlackRuntimeModule["sendMessageSlack"];
