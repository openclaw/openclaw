// Channel activity telemetry helpers without the broad infra-runtime barrel.

import type {
  PluginHookChannelGroupMembershipContext,
  PluginHookChannelGroupMembershipEvent,
} from "../plugins/hook-message.types.js";

export type {
  PluginHookChannelGroupMembershipContext,
  PluginHookChannelGroupMembershipEvent,
} from "../plugins/hook-message.types.js";

export { recordChannelActivity } from "../infra/channel-activity.js";

/** Observe provider membership notifications without admitting a message or starting a turn. */
export async function emitChannelGroupMembershipChanged(
  event: PluginHookChannelGroupMembershipEvent,
  context: PluginHookChannelGroupMembershipContext,
): Promise<void> {
  if (context.signal.aborted) {
    return;
  }
  const { getGlobalHookRunner } = await import("../plugins/hook-runner-global.js");
  if (!context.signal.aborted) {
    await getGlobalHookRunner()?.runChannelGroupMembershipChanged(event, context);
  }
}
