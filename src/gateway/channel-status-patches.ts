/** Channel status fields set when a transport establishes a fresh connection. */
export type ConnectedChannelStatusPatch = {
  connected: true;
  lastConnectedAt: number;
  lastEventAt: number;
};

/** Channel status fields set by heartbeat/activity without implying reconnect. */
export type TransportActivityChannelStatusPatch = {
  lastTransportActivityAt: number;
};

/** Builds the canonical connection-liveness patch with one shared timestamp. */
export function createConnectedChannelStatusPatch(
  at: number = Date.now(),
): ConnectedChannelStatusPatch {
  return {
    connected: true,
    lastConnectedAt: at,
    lastEventAt: at,
  };
}

/** Builds the transport-activity patch used by heartbeat-only status updates. */
export function createTransportActivityStatusPatch(
  at: number = Date.now(),
): TransportActivityChannelStatusPatch {
  return {
    lastTransportActivityAt: at,
  };
}
