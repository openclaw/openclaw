import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import type { OutboundSessionRoute } from "./outbound-session.js";

export function routeFixture(overrides: Partial<OutboundSessionRoute> = {}): OutboundSessionRoute {
  return {
    sessionKey: "agent:main:main",
    peer: { kind: "direct", id: "peer-agent" },
    chatType: "direct",
    from: "reef:peer-agent",
    to: "reef:peer-agent",
    ...overrides,
    baseSessionKey: overrides.baseSessionKey ?? overrides.sessionKey ?? "agent:main:main",
  };
}

export function routePlugin(
  id: string,
  route:
    | OutboundSessionRoute
    | NonNullable<NonNullable<ChannelPlugin["messaging"]>["resolveOutboundSessionRoute"]>,
): ChannelPlugin {
  return {
    ...createChannelTestPluginBase({ id }),
    messaging: {
      resolveOutboundSessionRoute: typeof route === "function" ? route : () => route,
    },
  };
}
