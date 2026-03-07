export type ConnectedChannelStatusPatch = {
  connected: true;
  lastConnectedAt: number;
  lastEventAt: number;
};

export function createConnectedChannelStatusPatch(
  at: number = Date.now(),
): ConnectedChannelStatusPatch {
  return {
    connected: true,
    lastConnectedAt: at,
    lastEventAt: at,
  };
}
