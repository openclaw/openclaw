// Plugin subscriptions to gateway-validated node events.
//
// The gateway validates each node-event payload against its schema owner
// before delivery; plugins subscribe by exact event name and receive typed
// data — never raw payload JSON. Registration-time allowlists and
// one-owner-per-event checks live with the plugin registry registrars.

export type OpenClawPluginNodeEventConsumerParams<TPayload> = {
  /** Stable paired-node id that emitted the event. */
  nodeId: string;
  /** Payload validated by the gateway-protocol schema owner before delivery. */
  payload: TPayload;
};

/**
 * Consumers may be synchronous (void) or asynchronous (Promise<void>). The
 * gateway observes both: a returned promise is caught and logged so an
 * async consumer failure stays isolated instead of reaching the
 * process-level unhandled-rejection path (which exits the Gateway).
 */
export type OpenClawPluginNodeEventConsumer<TPayload = unknown> = (
  params: OpenClawPluginNodeEventConsumerParams<TPayload>,
) => void | Promise<void>;

export type OpenClawPluginNodeEventSubscription<TPayload = unknown> = {
  /**
   * Exact node event names to consume. Core refuses names outside
   * NODE_EVENT_CONSUMER_EVENTS and refuses a second owner for an already
   * registered event.
   */
  events: [string, ...string[]];
  handle: OpenClawPluginNodeEventConsumer<TPayload>;
};

/**
 * Node events the gateway router currently delivers to plugin consumers.
 * One source of truth for registration-time validation; a router dispatch
 * case (with its schema owner) must exist before an event name is added.
 */
export const NODE_EVENT_CONSUMER_EVENTS = ["location.update"] as const;
