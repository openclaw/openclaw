/** State-version counters attached to broadcasts so clients can ignore stale snapshots. */
type GatewayBroadcastStateVersion = {
  presence?: number;
  health?: number;
};

/** Delivery controls for gateway broadcasts, including slow-socket backpressure policy. */
export type GatewayBroadcastOpts = {
  dropIfSlow?: boolean;
  stateVersion?: GatewayBroadcastStateVersion;
};

/** Broadcasts a scoped gateway event to every connected client authorized for that event. */
export type GatewayBroadcastFn = (
  event: string,
  payload: unknown,
  opts?: GatewayBroadcastOpts,
) => void;

/** Broadcasts a scoped gateway event only to authorized clients in the target connection set. */
export type GatewayBroadcastToConnIdsFn = (
  event: string,
  payload: unknown,
  connIds: ReadonlySet<string>,
  opts?: GatewayBroadcastOpts,
) => void;
