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

type ListSlackDirectoryGroupsLive =
  typeof import("../../../extensions/slack/src/directory-live.js").listSlackDirectoryGroupsLive;
type ListSlackDirectoryPeersLive =
  typeof import("../../../extensions/slack/src/directory-live.js").listSlackDirectoryPeersLive;
type MonitorSlackProvider =
  typeof import("../../../extensions/slack/src/index.js").monitorSlackProvider;
type ProbeSlack = typeof import("../../../extensions/slack/src/probe.js").probeSlack;
type ResolveSlackChannelAllowlist =
  typeof import("../../../extensions/slack/src/resolve-channels.js").resolveSlackChannelAllowlist;
type ResolveSlackUserAllowlist =
  typeof import("../../../extensions/slack/src/resolve-users.js").resolveSlackUserAllowlist;
type SendMessageSlack = typeof import("../../../extensions/slack/src/send.js").sendMessageSlack;
type HandleSlackAction = typeof import("../../agents/tools/slack-actions.js").handleSlackAction;

export function listSlackDirectoryGroupsLive(
  ...args: Parameters<ListSlackDirectoryGroupsLive>
): ReturnType<ListSlackDirectoryGroupsLive> {
  return listSlackDirectoryGroupsLiveImpl(...args);
}

export function listSlackDirectoryPeersLive(
  ...args: Parameters<ListSlackDirectoryPeersLive>
): ReturnType<ListSlackDirectoryPeersLive> {
  return listSlackDirectoryPeersLiveImpl(...args);
}

export function monitorSlackProvider(
  ...args: Parameters<MonitorSlackProvider>
): ReturnType<MonitorSlackProvider> {
  return monitorSlackProviderImpl(...args);
}

export function probeSlack(...args: Parameters<ProbeSlack>): ReturnType<ProbeSlack> {
  return probeSlackImpl(...args);
}

export function resolveSlackChannelAllowlist(
  ...args: Parameters<ResolveSlackChannelAllowlist>
): ReturnType<ResolveSlackChannelAllowlist> {
  return resolveSlackChannelAllowlistImpl(...args);
}

export function resolveSlackUserAllowlist(
  ...args: Parameters<ResolveSlackUserAllowlist>
): ReturnType<ResolveSlackUserAllowlist> {
  return resolveSlackUserAllowlistImpl(...args);
}

export function sendMessageSlack(
  ...args: Parameters<SendMessageSlack>
): ReturnType<SendMessageSlack> {
  return sendMessageSlackImpl(...args);
}

export function handleSlackAction(
  ...args: Parameters<HandleSlackAction>
): ReturnType<HandleSlackAction> {
  return handleSlackActionImpl(...args);
}
