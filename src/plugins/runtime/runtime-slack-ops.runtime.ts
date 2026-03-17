import {
  listSlackDirectoryGroupsLive as listSlackDirectoryGroupsLiveImpl,
  listSlackDirectoryPeersLive as listSlackDirectoryPeersLiveImpl,
} from "../../../extensions/slack/src/directory-live.js";
import { monitorSlackProvider as monitorSlackProviderImpl } from "../../../extensions/slack/src/index.js";
import { probeSlack as probeSlackImpl } from "../../../extensions/slack/src/probe.js";
import { resolveSlackChannelAllowlist as resolveSlackChannelAllowlistImpl } from "../../../extensions/slack/src/resolve-channels.js";
import { resolveSlackUserAllowlist as resolveSlackUserAllowlistImpl } from "../../../extensions/slack/src/resolve-users.js";
import { sendMessageSlack as sendMessageSlackImpl } from "../../../extensions/slack/src/send.js";
import { handleSlackAction as handleSlackActionImpl } from "../../agents/tools/slack-actions.js";
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
