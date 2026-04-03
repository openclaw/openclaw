import {
  listSlackDirectoryGroupsLive as listSlackDirectoryGroupsLiveImpl,
  listSlackDirectoryPeersLive as listSlackDirectoryPeersLiveImpl,
  monitorSlackProvider as monitorSlackProviderImpl,
  probeSlack as probeSlackImpl,
  resolveSlackChannelAllowlist as resolveSlackChannelAllowlistImpl,
  resolveSlackUserAllowlist as resolveSlackUserAllowlistImpl,
  sendMessageSlack as sendMessageSlackImpl,
  handleSlackAction as handleSlackActionImpl,
} from "../../plugin-sdk/slack-runtime-surface.js";
import type { PluginRuntimeChannel } from "./types-channel.js";

type RuntimeSlackOps = Pick<
  PluginRuntimeChannel["slack"],
  | "listDirectoryGroupsLive"
  | "listDirectoryPeersLive"
  | "probeSlack"
  | "resolveChannelAllowlist"
  | "resolveUserAllowlist"
  | "sendMessageSlack"
  | "monitorSlackProvider"
  | "handleSlackAction"
>;

export const runtimeSlackOps = {
  listDirectoryGroupsLive: listSlackDirectoryGroupsLiveImpl,
  listDirectoryPeersLive: listSlackDirectoryPeersLiveImpl,
  probeSlack: probeSlackImpl,
  resolveChannelAllowlist: resolveSlackChannelAllowlistImpl,
  resolveUserAllowlist: resolveSlackUserAllowlistImpl,
  sendMessageSlack: sendMessageSlackImpl,
  monitorSlackProvider: monitorSlackProviderImpl,
  handleSlackAction: handleSlackActionImpl,
} satisfies RuntimeSlackOps;
