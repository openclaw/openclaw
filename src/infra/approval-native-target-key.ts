import type { ChannelApprovalNativeTarget } from "../channels/plugins/approval-native.types.js";
import { channelRouteDedupeKey } from "../plugin-sdk/channel-route.js";

/**
 * Builds the stable route key used to dedupe native approval targets across plugins.
 *
 * The shared route key normalizes whitespace and numeric thread ids while preserving boundaries
 * between target parts, so channel-specific ids containing colons cannot collide accidentally.
 */
export function buildChannelApprovalNativeTargetKey(target: ChannelApprovalNativeTarget): string {
  return channelRouteDedupeKey({
    to: target.to,
    threadId: target.threadId,
  });
}
