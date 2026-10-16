// Lost custody cannot be regained in-process: every state operation stays
// fenced, so a Gateway that keeps listening is a zombie whose clients hang in
// reconnect loops (observed after sleep/wake). The restart policy stays outside
// this graph: gateway-state-owner sits in the state worker's static closure,
// and any edge into ./restart.js (static or dynamic) pulls the restart modules
// into the unified bundle's eager core and breaks the PR wrapper source-closure
// inventory gate. The gateway run loop therefore registers the handler below;
// holders without one (CLI one-shots, doctor, tests) keep the fence as their
// terminal contract and let their caller decide.
type StateOwnerCustodyRestartHandler = (reason: string) => void;

let custodyRestartHandler: StateOwnerCustodyRestartHandler | null = null;

export function setGatewayStateOwnerCustodyRestartHandler(
  handler: StateOwnerCustodyRestartHandler,
): () => void {
  const previous = custodyRestartHandler;
  custodyRestartHandler = handler;
  return () => {
    if (custodyRestartHandler === handler) {
      custodyRestartHandler = previous;
    }
  };
}

export function scheduleStateOwnerCustodyRestart(): void {
  custodyRestartHandler?.("state-owner custody lost");
}
