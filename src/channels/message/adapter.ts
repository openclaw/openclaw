import type { ChannelMessageActionName } from "../plugins/message-action-names.js";
import type { AnyChannelPlugin } from "../plugins/types.plugin.js";
import type {
  ChannelMessageAdapter,
  ChannelMessageAdapterShape,
  ChannelMessageReceiveAdapterShape,
} from "./types.js";

export const defaultManualReceiveAdapter = {
  defaultAckPolicy: "manual",
  supportedAckPolicies: ["manual"],
} as const satisfies ChannelMessageReceiveAdapterShape;

type ChannelMessageAdapterWithDefaultReceive<TAdapter extends ChannelMessageAdapterShape> =
  TAdapter & {
    receive: TAdapter["receive"] extends undefined
      ? typeof defaultManualReceiveAdapter
      : NonNullable<TAdapter["receive"]>;
  };

/** Defines a message adapter while defaulting receive acknowledgement to manual. */
export function defineChannelMessageAdapter<const TAdapter extends ChannelMessageAdapterShape>(
  adapter: TAdapter,
): ChannelMessageAdapter<ChannelMessageAdapterWithDefaultReceive<TAdapter>> {
  return {
    ...adapter,
    receive: adapter.receive ?? defaultManualReceiveAdapter,
  } as ChannelMessageAdapter<ChannelMessageAdapterWithDefaultReceive<TAdapter>>;
}

/** The outbound execution surfaces that can carry a text payload. */
export function hasChannelMessageSender(plugin: AnyChannelPlugin | undefined): boolean {
  return Boolean(
    plugin?.outbound?.sendText ||
    plugin?.outbound?.deliveryMode === "gateway" ||
    plugin?.message?.send?.text,
  );
}

/** A provider-owned action can use its registered handler even on a channel without a text sender. */
export function hasProviderActionHandler(
  plugin: AnyChannelPlugin | undefined,
  action: ChannelMessageActionName | undefined,
): boolean {
  return Boolean(
    action &&
    action !== "send" &&
    action !== "poll" &&
    plugin?.actions?.handleAction &&
    plugin.actions.supportsAction?.({ action }) !== false,
  );
}
