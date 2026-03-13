import { evaluateGroupRouteAccessForPolicy } from "../../plugin-sdk/group-access.js";

export function isSlackChannelAllowedByPolicy(params: {
  groupPolicy: "open" | "disabled" | "allowlist" | "members";
  channelAllowlistConfigured: boolean;
  channelAllowed: boolean;
}): boolean {
  return evaluateGroupRouteAccessForPolicy({
    groupPolicy: params.groupPolicy,
    routeAllowlistConfigured: params.channelAllowlistConfigured,
    routeMatched: params.channelAllowed,
  }).allowed;
}
