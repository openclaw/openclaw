import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import type { ActiveTaskRestartBlocker } from "../tasks/task-restart-blocker.js";
import {
  createGatewayActiveWorkSnapshot,
  type GatewayActiveWorkBlocker,
  type GatewayActiveWorkInspectors,
} from "./gateway-active-work.js";
import {
  scheduleGatewaySigusr1Restart,
  type RestartAuditInfo,
  type ScheduledRestart,
} from "./restart.js";

// Safe restart coordination checks active local work before scheduling SIGUSR1
// restarts, while still allowing explicit deferral bypasses for operators.
export type SafeGatewayRestartCounts = {
  queueSize: number;
  pendingReplies: number;
  embeddedRuns: number;
  cronRuns: number;
  backgroundExecSessions: number;
  rootRequests: number;
  activeTasks: number;
  totalActive: number;
};
export type SafeGatewayRestartBlocker = Omit<GatewayActiveWorkBlocker, "kind"> & {
  kind:
    | "queue"
    | "reply"
    | "embedded-run"
    | "cron-run"
    | "background-exec"
    | "root-request"
    | "task";
};

type SafeRestartInspectors = Pick<
  GatewayActiveWorkInspectors,
  | "getQueueSize"
  | "getPendingReplies"
  | "getEmbeddedRuns"
  | "getCronRuns"
  | "getBackgroundExecSessions"
  | "getRootRequests"
  | "getActiveTasks"
  | "getTaskBlockers"
>;

export type SafeGatewayRestartPreflight = {
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

function formatDurableTaskBlocker(task: ActiveTaskRestartBlocker): string {
  return [
    `taskId=${task.taskId}`,
    task.runId ? `runId=${task.runId}` : null,
    `status=${task.status}`,
    `runtime=${task.runtime}`,
    task.label ? `label=${task.label}` : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
}

function createAuditSafeRestartBlocker(
  blocker: SafeGatewayRestartBlocker,
): SafeGatewayRestartBlocker {
  if (blocker.kind !== "task" || !blocker.task) {
    return { ...blocker };
  }
  const task: ActiveTaskRestartBlocker = {
    taskId: blocker.task.taskId,
    status: blocker.task.status,
    runtime: blocker.task.runtime,
    ...(blocker.task.runId ? { runId: blocker.task.runId } : {}),
    ...(blocker.task.label ? { label: blocker.task.label } : {}),
  };
  return {
    ...blocker,
    message: formatDurableTaskBlocker(task),
    task,
  };
}

function createAuditSafeGatewayRestartPreflight(
  preflight: SafeGatewayRestartPreflight,
): SafeGatewayRestartPreflight {
  const blockers = preflight.blockers.map(createAuditSafeRestartBlocker);
  return {
    ...preflight,
    blockers,
    summary:
      blockers.length === 0
        ? "safe to restart now"
        : `restart deferred: ${blockers.map((blocker) => blocker.message).join("; ")}`,
  };
}
export function createSafeGatewayRestartPreflight(
  inspectors: Partial<SafeRestartInspectors> = {},
): SafeGatewayRestartPreflight {
  const snapshot = createGatewayActiveWorkSnapshot({
    ...inspectors,
    // Restart RPC preflight itself owns a root. Count every other admitted
    // handoff so signal emission cannot split spawn from durable ownership.
    getRootRequests:
      inspectors.getRootRequests ?? (() => getActiveGatewayRootWorkCount({ excludeCurrent: true })),
    getSessionAdmissions: () => 0,
    getSessionMutations: () => 0,
    getChatRuns: () => 0,
    getQueuedTurns: () => 0,
    getTerminalPersistence: () => 0,
    getTerminalSessions: () => 0,
  });
  const counts: SafeGatewayRestartCounts = {
    queueSize: snapshot.counts.queueSize,
    pendingReplies: snapshot.counts.pendingReplies,
    embeddedRuns: snapshot.counts.embeddedRuns,
    cronRuns: snapshot.counts.cronRuns,
    backgroundExecSessions: snapshot.counts.backgroundExecSessions,
    rootRequests: snapshot.counts.rootRequests,
    activeTasks: snapshot.counts.activeTasks,
    totalActive:
      snapshot.counts.queueSize +
      snapshot.counts.pendingReplies +
      snapshot.counts.embeddedRuns +
      snapshot.counts.cronRuns +
      snapshot.counts.backgroundExecSessions +
      snapshot.counts.rootRequests +
      snapshot.counts.activeTasks,
  };
  const blockers = snapshot.blockers as SafeGatewayRestartBlocker[];

  const summary =
    blockers.length === 0
      ? "safe to restart now"
      : `restart deferred: ${blockers.map((blocker) => blocker.message).join("; ")}`;
  return {
    safe: counts.totalActive === 0,
    counts,
    blockers,
    summary,
  };
}

/** Schedule a gateway restart after collecting tracked active-work blockers. */
export function requestSafeGatewayRestart(
  opts: {
    reason?: string;
    delayMs?: number;
    skipDeferral?: boolean;
    preservePendingEmitHooks?: boolean;
    inspect?: Partial<SafeRestartInspectors>;
    audit?: RestartAuditInfo;
  } = {},
): SafeGatewayRestartRequestResult {
  const preflight = createSafeGatewayRestartPreflight(opts.inspect);
  const auditPreflight = createAuditSafeGatewayRestartPreflight(preflight);
  const skipDeferral = opts.skipDeferral === true;
  const reason = opts.reason ?? "gateway.restart.safe";
  const restart = scheduleGatewaySigusr1Restart({
    delayMs: opts.delayMs ?? 0,
    reason,
    audit: {
      ...opts.audit,
      source: "requestSafeGatewayRestart",
      preflight: auditPreflight,
      context: {
        ...opts.audit?.context,
        preflightSummary: auditPreflight.summary,
        preflightCounts: preflight.counts,
      },
    },
    ...(opts.preservePendingEmitHooks === true || skipDeferral
      ? { preservePendingEmitHooksOnDeferralBypass: true }
      : {}),
    ...(skipDeferral ? { skipDeferral: true } : {}),
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
