import {
  listSlackDirectoryGroupsLive,
  listSlackDirectoryPeersLive,
} from "../../../extensions/slack/src/directory-live.js";
import { monitorSlackProvider } from "../../../extensions/slack/src/index.js";
import { probeSlack } from "../../../extensions/slack/src/probe.js";
import { resolveSlackChannelAllowlist } from "../../../extensions/slack/src/resolve-channels.js";
import { resolveSlackUserAllowlist } from "../../../extensions/slack/src/resolve-users.js";
import { sendMessageSlack } from "../../../extensions/slack/src/send.js";
import { handleSlackAction } from "../../agents/tools/slack-actions.js";
import type { PluginRuntimeChannel } from "./types-channel.js";

export function createRuntimeSlack(): PluginRuntimeChannel["slack"] {
  return {
    listDirectoryGroupsLive: listSlackDirectoryGroupsLive,
    listDirectoryPeersLive: listSlackDirectoryPeersLive,
    probeSlack,
    resolveChannelAllowlist: resolveSlackChannelAllowlist,
    resolveUserAllowlist: resolveSlackUserAllowlist,
    sendMessageSlack,
    monitorSlackProvider,
    handleSlackAction,
  };
}
