import {
  listSlackDirectoryGroupsLive as listSlackDirectoryGroupsLiveImpl,
  listSlackDirectoryPeersLive as listSlackDirectoryPeersLiveImpl,
} from "../../../extensions/slack/runtime-api.js";
import { monitorSlackProvider as monitorSlackProviderImpl } from "../../../extensions/slack/runtime-api.js";
import { probeSlack as probeSlackImpl } from "../../../extensions/slack/runtime-api.js";
import { resolveSlackChannelAllowlist as resolveSlackChannelAllowlistImpl } from "../../../extensions/slack/runtime-api.js";
import { resolveSlackUserAllowlist as resolveSlackUserAllowlistImpl } from "../../../extensions/slack/runtime-api.js";
import { sendMessageSlack as sendMessageSlackImpl } from "../../../extensions/slack/runtime-api.js";
import { handleSlackAction as handleSlackActionImpl } from "../../../extensions/slack/runtime-api.js";
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
