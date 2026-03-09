export type InboundPauseMode = "active" | "paused_silent" | "paused_autoreply";

export type InboundRoutePolicy = {
  allowAgentDispatch: boolean;
  allowTextCommands: boolean;
  allowOperationalDirectives: boolean;
  pauseMode: InboundPauseMode;
  pauseReplyText?: string;
};

export const DEFAULT_INBOUND_ROUTE_POLICY: InboundRoutePolicy = {
  allowAgentDispatch: true,
  allowTextCommands: true,
  allowOperationalDirectives: true,
  pauseMode: "active",
};
