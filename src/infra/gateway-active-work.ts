import type {
  GatewaySuspendBlocker,
  GatewayWriteCustody,
} from "../../packages/gateway-protocol/src/schema/gateway-suspend.js";
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
import { waitForGatewayDrain } from "./gateway-drain.js";
import { readLifecycleWriteCustody } from "./lifecycle-write-custody.js";

export type GatewayActiveWorkBlocker = GatewaySuspendBlocker;
export type GatewayActiveWorkSnapshot = ReturnType<typeof createGatewayActiveWorkSnapshot>;

type GatewayActiveWorkWaitResult = {
  drained: boolean;
  snapshot: GatewayActiveWorkSnapshot;
};

export type GatewayActiveWorkInspectors = Omit<
  typeof defaultInspectors,
  "getRootRequestHolders"
> & {
  getRootRequestHolders?: () => string[];
  getChatRunHolders?: () => string[];
  getTerminalPersistenceHolders?: () => string[];
};

const defaultInspectors = {
  getQueueSize: getTotalQueueSize,
  getPendingReplies: getTotalPendingReplies,
  getEmbeddedRuns: getActiveEmbeddedRunCount,
  getBackgroundExecSessions: getActiveBackgroundExecSessionCount,
  getCronRuns: () => Math.max(getActiveCronJobCount(), getSuspensionVisibleCronTaskRunCount()),
  getAgentRuns: getActiveAgentRunContextCount,
  getAcpRuns: getActiveAcpTurnCount,
  getMediaRuns: getActiveMediaGenerationRunCount,
  getRootRequests: () =>
    getActiveGatewayRootWorkCount({ excludeCurrent: true, excludeReadonly: true }),
  getRootRequestHolders: () =>
    getActiveGatewayRootWorkHolders({ excludeCurrent: true, excludeReadonly: true }),
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
) {
  const resolved = { ...defaultInspectors, ...inspectors };
  const maintenance = readGatewayMaintenanceWork(inspectors);
  const counts = {
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
    /** Compatibility aggregate. Categories can overlap; use individual counts for diagnostics. */
    totalActive: 0,
  };
  counts.totalActive =
    Object.values(counts).reduce((total, count) => total + count, 0) -
    (options.ignoreTerminalSessions ? counts.terminalSessions : 0);

  const blockers: GatewayActiveWorkBlocker[] = [];
  const add = (
    count: number,
    kind: GatewayActiveWorkBlocker["kind"],
    message: string,
    getHolders?: () => string[],
  ) => {
    if (count > 0) {
      const holders = getHolders?.().toSorted() ?? [];
      const names = holders.slice(0, 8).map((name) => name.replace(/[\r\n\t]/g, " ").slice(0, 256));
      if (holders.length > names.length) {
        names.push(`+${holders.length - names.length} more`);
      }
      blockers.push({
        kind,
        count,
        message: `${count} ${message}${names.length > 0 ? `: ${names.join(", ")}` : ""}`,
      });
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
  add(
    counts.rootRequests,
    "root-request",
    "active gateway request(s)",
    inspectors.getRootRequests && !inspectors.getRootRequestHolders
      ? undefined
      : resolved.getRootRequestHolders,
  );
  add(counts.sessionAdmissions, "session-admission", "admitted session turn(s)");
  add(counts.sessionMutations, "session-mutation", "active session lifecycle mutation(s)");
  add(counts.chatRuns, "chat-run", "active chat run(s)", resolved.getChatRunHolders);
  add(counts.queuedTurns, "queued-turn", "queued chat turn(s)");
  add(
    counts.terminalPersistence,
    "terminal-persistence",
    "pending terminal session write(s)",
    resolved.getTerminalPersistenceHolders,
  );
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
  return waitForGatewayDrain(createGatewayActiveWorkSnapshot, timeoutMs, {
    ...options,
    pollMs: GATEWAY_ACTIVE_WORK_POLL_MS,
  });
}
