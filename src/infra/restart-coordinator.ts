import {
  createGatewayActiveWorkSnapshot,
  type GatewayActiveWorkBlocker,
  type GatewayActiveWorkInspectors,
} from "./gateway-active-work.js";
import { scheduleGatewayRestart, type ScheduledRestart } from "./restart.js";

// Safe restart coordination checks active local work before scheduling SIGUSR2
// restarts, while still allowing explicit deferral bypasses for operators.
type SafeGatewayRestartCounts = {
  queueSize: number;
  pendingReplies: number;
  embeddedRuns: number;
  cronRuns: number;
  backgroundExecSessions: number;
  rootRequests: number;
  agentRuns: number;
  acpRuns: number;
  mediaRuns: number;
  totalActive: number;
};
type SafeGatewayRestartBlocker = Omit<GatewayActiveWorkBlocker, "kind"> & {
  kind:
    | "queue"
    | "reply"
    | "embedded-run"
    | "cron-run"
    | "background-exec"
    | "root-request"
    | "agent-run"
    | "acp-run"
    | "media-generation";
};

type SafeRestartInspectors = Pick<
  GatewayActiveWorkInspectors,
  | "getQueueSize"
  | "getPendingReplies"
  | "getEmbeddedRuns"
  | "getCronRuns"
  | "getBackgroundExecSessions"
  | "getRootRequests"
  | "getAgentRuns"
  | "getAcpRuns"
  | "getMediaRuns"
>;

type SafeGatewayRestartPreflight = {
  safe: boolean;
  counts: SafeGatewayRestartCounts;
  blockers: SafeGatewayRestartBlocker[];
  summary: string;
};

export type SafeGatewayRestartRequestResult = {
  ok: true;
  status: "scheduled" | "deferred" | "coalesced";
  preflight: SafeGatewayRestartPreflight;
  restart: ScheduledRestart;
};

export function createSafeGatewayRestartPreflight(
  inspectors: Partial<SafeRestartInspectors> = {},
): SafeGatewayRestartPreflight {
  const snapshot = createGatewayActiveWorkSnapshot({
    ...inspectors,
    getSessionAdmissions: () => 0,
    getSessionMutations: () => 0,
    getChatRuns: () => 0,
    getQueuedTurns: () => 0,
    getTerminalPersistence: () => 0,
    getTerminalSessions: () => 0,
  });
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
  };
  const totalActive = Object.values(counts).reduce((total, count) => total + count, 0);
  const blockers = snapshot.blockers as SafeGatewayRestartBlocker[];

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
    delayMs?: number;
    skipDeferral?: boolean;
    inspect?: Partial<SafeRestartInspectors>;
  } = {},
): SafeGatewayRestartRequestResult {
  const preflight = createSafeGatewayRestartPreflight(opts.inspect);
  const skipDeferral = opts.skipDeferral === true;
  const restart = scheduleGatewayRestart({
    delayMs: opts.delayMs ?? 0,
    reason: opts.reason ?? "gateway.restart.safe",
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
