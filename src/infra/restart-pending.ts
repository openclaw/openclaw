import type { GatewayRestartSignalAdmissionLease } from "../process/gateway-work-admission.js";

// The restart controller owns these handles. Recovery reads them directly so cancellation,
// rollback and reset cannot leave behind a stale pending flag.
export const pendingGatewayRestart: {
  timer: ReturnType<typeof setTimeout> | null;
  readonly deferralPolls: Set<ReturnType<typeof setInterval>>;
  signalAdmission: GatewayRestartSignalAdmissionLease | null;
} = {
  timer: null,
  deferralPolls: new Set(),
  signalAdmission: null,
};

/** Live restart work, including preparation that still leaves inbound admission open. */
export function hasPendingGatewayRestart(): boolean {
  // Idle preparation owns a poll; fenced preparation owns its admission lease. The preparing
  // flag alone can outlive a refused custom emission and does not establish live recovery.
  return (
    pendingGatewayRestart.timer !== null ||
    pendingGatewayRestart.deferralPolls.size > 0 ||
    pendingGatewayRestart.signalAdmission !== null
  );
}
