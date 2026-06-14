// Default restart drain is 300s; service supervisors need reserve time for
// close handoff before escalating to a hard kill.
export const GATEWAY_SERVICE_STOP_TIMEOUT_SECONDS = 330;
