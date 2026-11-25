import { createGatewayActiveWorkSnapshot } from "./gateway-active-work.js";
import type { RestartEmitHooks } from "./restart-request.js";
import { scheduleGatewayRestart, type ScheduledRestart } from "./restart.js";

// Safe restart coordination checks active local work before scheduling SIGUSR2
// restarts, while still allowing explicit deferral bypasses for operators.
export type SafeGatewayRestartRequestResult = {
  ok: true;
  status: "scheduled" | "deferred" | "coalesced";
  preflight: ReturnType<typeof createSafeGatewayRestartPreflight>;
  restart: ScheduledRestart;
};

export function createSafeGatewayRestartPreflight() {
  const snapshot = createGatewayActiveWorkSnapshot();
  const counts = {
    queueSize: snapshot.counts.queueSize,
    pendingReplies: snapshot.counts.pendingReplies,
    embeddedRuns: snapshot.counts.embeddedRuns,
    cronRuns: snapshot.counts.cronRuns,
    backgroundExecSessions: snapshot.counts.backgroundExecSessions,
    rootRequests: snapshot.counts.rootRequests,
    agentRuns: snapshot.counts.agentRuns,
    acpRuns: snapshot.counts.acpRuns,
    mediaRuns: snapshot.counts.mediaRuns,
    sessionAdmissions: snapshot.counts.sessionAdmissions,
    sessionMutations: snapshot.counts.sessionMutations,
    chatRuns: snapshot.counts.chatRuns,
    queuedTurns: snapshot.counts.queuedTurns,
    terminalPersistence: snapshot.counts.terminalPersistence,
    terminalSessions: snapshot.counts.terminalSessions,
  };
  const totalActive = Object.values(counts).reduce((total, count) => total + count, 0);
  const blockers = snapshot.blockers;

  const summary =
    blockers.length === 0
      ? "safe to restart now"
      : `restart deferred: ${blockers.map((blocker) => blocker.message).join("; ")}`;
  return {
    safe: totalActive === 0,
    counts: { ...counts, totalActive },
    blockers,
    summary,
  };
}

/** Schedule a gateway restart after collecting tracked active-work blockers. */
export function scheduleSafeGatewayRestart(
  opts: {
    reason?: string;
    skipDeferral?: boolean;
    sessionKey?: string;
    emitHooks?: RestartEmitHooks;
  } = {},
): SafeGatewayRestartRequestResult {
  const preflight = createSafeGatewayRestartPreflight();
  const skipDeferral = opts.skipDeferral === true;
  const restart = scheduleGatewayRestart({
    delayMs: 0,
    reason: opts.reason ?? "gateway.restart.safe",
    ...(opts.sessionKey ? { sessionKey: opts.sessionKey } : {}),
    ...(opts.emitHooks ? { emitHooks: opts.emitHooks } : {}),
    ...(skipDeferral ? { preservePendingEmitHooksOnDeferralBypass: true, skipDeferral: true } : {}),
  });
  const status = restart.coalesced
    ? "coalesced"
    : skipDeferral || preflight.safe
      ? "scheduled"
      : "deferred";
  return {
    ok: true,
    status,
    preflight,
    restart,
  };
}
