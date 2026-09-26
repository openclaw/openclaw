import type { GatewayWriteCustody } from "../../packages/gateway-protocol/src/schema/gateway-suspend.js";
// Collects process activity shared by restart and host-suspension decisions.
import { getActiveAcpTurnCount } from "../acp/control-plane/active-turns.js";
import { getActiveBackgroundExecSessionCount } from "../agents/bash-process-registry.js";
import { getActiveEmbeddedRunCount } from "../agents/embedded-agent-runner/active-run-projections.js";
import { getActiveMediaGenerationRunCount } from "../agents/media-generation-activity.js";
import { getTotalPendingReplies } from "../auto-reply/reply/dispatcher-registry.js";
import { getActiveCronJobCount } from "../cron/active-jobs.js";
import { getSuspensionVisibleCronTaskRunCount } from "../cron/service/active-run-cancellation.js";
import { getTotalQueueSize } from "../process/command-queue.js";
import {
  getActiveGatewayRootWorkCount,
  getActiveGatewayRootWorkHolders,
} from "../process/gateway-work-admission.js";
import {
  getActiveSessionLifecycleMutationCount,
  getActiveSessionWorkAdmissionCount,
} from "../sessions/session-lifecycle-admission.js";
import { getActiveAgentRunContextCount } from "./agent-run-registry.js";
import { readLifecycleWriteCustody } from "./lifecycle-write-custody.js";

type GatewayActiveWorkCounts = {
  queueSize: number;
  pendingReplies: number;
  embeddedRuns: number;
  backgroundExecSessions: number;
  cronRuns: number;
  agentRuns: number;
  acpRuns: number;
  mediaRuns: number;
  rootRequests: number;
  sessionAdmissions: number;
  sessionMutations: number;
  chatRuns: number;
  queuedTurns: number;
  terminalPersistence: number;
  terminalSessions: number;
  lifecycleWrites: number;
  /** Compatibility aggregate. Categories can overlap; use individual counts for diagnostics. */
  totalActive: number;
};

export type GatewayActiveWorkBlocker = {
  kind:
    | "queue"
    | "reply"
    | "embedded-run"
    | "background-exec"
    | "cron-run"
    | "agent-run"
    | "acp-run"
    | "media-generation"
    | "root-request"
    | "session-admission"
    | "session-mutation"
    | "chat-run"
    | "queued-turn"
    | "terminal-persistence"
    | "terminal-session";
  count: number;
  message: string;
};

export type GatewayActiveWorkSnapshot = {
  idle: boolean;
  counts: GatewayActiveWorkCounts;
  blockers: GatewayActiveWorkBlocker[];
  writeCustody: GatewayWriteCustody;
};

type GatewayActiveWorkWaitResult = {
  drained: boolean;
  snapshot: GatewayActiveWorkSnapshot;
};

export type GatewayActiveWorkInspectors = {
  getQueueSize: () => number;
  getPendingReplies: () => number;
  getEmbeddedRuns: () => number;
  getBackgroundExecSessions: () => number;
  getCronRuns: () => number;
  getAgentRuns: () => number;
  getAcpRuns: () => number;
  getMediaRuns: () => number;
  getRootRequests: () => number;
  getRootRequestHolders?: () => string[];
  getSessionAdmissions: () => number;
  getSessionMutations: () => number;
  getChatRuns: () => number;
  getQueuedTurns: () => number;
  getTerminalPersistence: () => number;
  getTerminalSessions: () => number;
};

const defaultInspectors: GatewayActiveWorkInspectors = {
  getQueueSize: getTotalQueueSize,
  getPendingReplies: getTotalPendingReplies,
  getEmbeddedRuns: getActiveEmbeddedRunCount,
  getBackgroundExecSessions: getActiveBackgroundExecSessionCount,
  getCronRuns: () => Math.max(getActiveCronJobCount(), getSuspensionVisibleCronTaskRunCount()),
  getAgentRuns: getActiveAgentRunContextCount,
  getAcpRuns: getActiveAcpTurnCount,
  getMediaRuns: getActiveMediaGenerationRunCount,
  getRootRequests: () => getActiveGatewayRootWorkCount({ excludeCurrent: true }),
  getRootRequestHolders: () => getActiveGatewayRootWorkHolders({ excludeCurrent: true }),
  getSessionAdmissions: getActiveSessionWorkAdmissionCount,
  getSessionMutations: getActiveSessionLifecycleMutationCount,
  getChatRuns: () => 0,
  getQueuedTurns: () => 0,
  getTerminalPersistence: () => 0,
  getTerminalSessions: () => 0,
};

function normalizeCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Cheap projection for status; suspension still uses the complete snapshot below. */
export function readGatewayMaintenanceWork(inspectors: Partial<GatewayActiveWorkInspectors> = {}) {
  const resolved = { ...defaultInspectors, ...inspectors };
  const writeCustody: GatewayWriteCustody = readLifecycleWriteCustody();
  const counts = {
    rootRequests: normalizeCount(resolved.getRootRequests()),
    cronRuns: normalizeCount(resolved.getCronRuns()),
    sessionMutations: normalizeCount(resolved.getSessionMutations()),
    terminalPersistence: normalizeCount(resolved.getTerminalPersistence()),
    lifecycleWrites: writeCustody.reduce((sum, fact) => sum + fact.count, 0),
  };
  for (const [phase, count] of [
    ["session-mutation", counts.sessionMutations],
    ["terminal-persistence", counts.terminalPersistence],
  ] as const) {
    if (count > 0) {
      writeCustody.push({ phase, count });
    }
  }
  return { counts, writeCustody };
}

export function createGatewayActiveWorkSnapshot(
  inspectors: Partial<GatewayActiveWorkInspectors> = {},
  options: { ignoreTerminalSessions?: boolean } = {},
): GatewayActiveWorkSnapshot {
  const resolved = { ...defaultInspectors, ...inspectors };
  const maintenance = readGatewayMaintenanceWork(inspectors);
  const counts: GatewayActiveWorkCounts = {
    queueSize: normalizeCount(resolved.getQueueSize()),
    pendingReplies: normalizeCount(resolved.getPendingReplies()),
    embeddedRuns: normalizeCount(resolved.getEmbeddedRuns()),
    backgroundExecSessions: normalizeCount(resolved.getBackgroundExecSessions()),
    agentRuns: normalizeCount(resolved.getAgentRuns()),
    acpRuns: normalizeCount(resolved.getAcpRuns()),
    mediaRuns: normalizeCount(resolved.getMediaRuns()),
    sessionAdmissions: normalizeCount(resolved.getSessionAdmissions()),
    chatRuns: normalizeCount(resolved.getChatRuns()),
    queuedTurns: normalizeCount(resolved.getQueuedTurns()),
    terminalSessions: normalizeCount(resolved.getTerminalSessions()),
    ...maintenance.counts,
    totalActive: 0,
  };
  counts.totalActive =
    Object.values(counts).reduce((total, count) => total + count, 0) -
    (options.ignoreTerminalSessions ? counts.terminalSessions : 0);

  const blockers: GatewayActiveWorkBlocker[] = [];
  const add = (count: number, kind: GatewayActiveWorkBlocker["kind"], message: string) => {
    if (count > 0) {
      blockers.push({ kind, count, message: `${count} ${message}` });
    }
  };
  add(counts.queueSize, "queue", "queued or active operation(s)");
  add(counts.pendingReplies, "reply", "pending reply delivery operation(s)");
  add(counts.embeddedRuns, "embedded-run", "active embedded run(s)");
  add(counts.backgroundExecSessions, "background-exec", "active background exec session(s)");
  add(counts.cronRuns, "cron-run", "active cron run(s)");
  add(counts.agentRuns, "agent-run", "admitted agent run(s)");
  add(counts.acpRuns, "acp-run", "active ACP turn(s)");
  add(counts.mediaRuns, "media-generation", "active media generation(s)");
  const rootRequestHolders =
    inspectors.getRootRequests && !inspectors.getRootRequestHolders
      ? []
      : (resolved.getRootRequestHolders?.() ?? []);
  const rootRequestHolderNames = rootRequestHolders.toSorted().slice(0, 8);
  if (rootRequestHolders.length > rootRequestHolderNames.length) {
    rootRequestHolderNames.push(
      `+${rootRequestHolders.length - rootRequestHolderNames.length} more`,
    );
  }
  add(
    counts.rootRequests,
    "root-request",
    `active gateway request(s)${rootRequestHolderNames.length > 0 ? `: ${rootRequestHolderNames.join(", ")}` : ""}`,
  );
  add(counts.sessionAdmissions, "session-admission", "admitted session turn(s)");
  add(counts.sessionMutations, "session-mutation", "active session lifecycle mutation(s)");
  add(counts.chatRuns, "chat-run", "active chat run(s)");
  add(counts.queuedTurns, "queued-turn", "queued chat turn(s)");
  add(counts.terminalPersistence, "terminal-persistence", "pending terminal session write(s)");
  if (!options.ignoreTerminalSessions) {
    add(counts.terminalSessions, "terminal-session", "open terminal session(s)");
  }

  return {
    idle: counts.totalActive === 0,
    counts,
    blockers,
    writeCustody: maintenance.writeCustody,
  };
}

const GATEWAY_ACTIVE_WORK_POLL_MS = 250;

/** Waits for the complete process-wide active-work inventory to become idle. */
export async function waitForGatewayActiveWork(
  timeoutMs?: number,
  options: { onSnapshot?: (snapshot: GatewayActiveWorkSnapshot) => void } = {},
): Promise<GatewayActiveWorkWaitResult> {
  const timeout =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
      ? Math.max(0, Math.floor(timeoutMs))
      : undefined;
  const deadlineAt = timeout === undefined ? undefined : Date.now() + timeout;

  while (true) {
    const snapshot = createGatewayActiveWorkSnapshot();
    options.onSnapshot?.(snapshot);
    if (snapshot.idle) {
      return { drained: true, snapshot };
    }
    const remainingMs = deadlineAt === undefined ? undefined : deadlineAt - Date.now();
    if (remainingMs !== undefined && remainingMs <= 0) {
      return { drained: false, snapshot };
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(GATEWAY_ACTIVE_WORK_POLL_MS, remainingMs ?? Infinity));
    });
  }
}
