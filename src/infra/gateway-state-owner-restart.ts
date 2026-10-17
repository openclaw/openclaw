// Lost custody cannot be regained in-process: every state operation stays
// fenced, so a Gateway that keeps listening is a zombie whose clients hang in
// reconnect loops (observed after sleep/wake). Ask the run loop to restart
// through the supervisor immediately; skipDeferral because admission is
// already closed and idle may never arrive. Holders without a run-loop
// SIGUSR2 listener (CLI one-shots, tests) keep the fence as their terminal
// contract and let their caller decide.
//
// The restart graph stays dynamically loaded: gateway-state-owner sits in the
// state worker's static closure, and a static edge here pulls the restart
// modules into the unified bundle's eager core, breaking its lazy boundaries.
export function scheduleStateOwnerCustodyRestart(): void {
  if (process.listenerCount("SIGUSR2") > 0) {
    void import("./restart.js").then(({ scheduleGatewayRestart }) => {
      scheduleGatewayRestart({ reason: "state-owner custody lost", skipDeferral: true });
    });
  }
}
