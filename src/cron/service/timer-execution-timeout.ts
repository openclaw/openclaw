import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.read.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { CronActiveJobMarker } from "../active-jobs.js";
import type { CronCompletionDeliveryFence } from "../delivery-attempt-fence.js";
import type { CronRunReceiptSettlementDisposition } from "../store/run-receipt-store.js";
import type { CronRunReceiptHandle } from "../store/run-receipt.types.js";
import type {
  CronAgentExecutionPhaseUpdate,
  CronAgentExecutionStarted,
  CronCompletionStatus,
  CronJob,
  CronJobExecutionResult,
  CronNextCheckProposal,
  CronResolvedDeliveryState,
  CronRunOutcome,
  CronRunDeliveryResult,
  CronRunTelemetry,
} from "../types.js";
import type { CronServiceState } from "./state.js";

export const MAX_CRON_TIMER_DELAY_MS = 60_000;

/**
 * Minimum gap between consecutive fires of the same cron job.  This is a
 * safety net that prevents spin-loops when `computeJobNextRunAtMs` returns
 * a value within the same second as the just-completed run.  The guard
 * is intentionally generous (2 s) so it never masks a legitimate schedule
 * but always breaks an infinite re-trigger cycle.  (See #17821)
 */
export const MIN_REFIRE_GAP_MS = 2_000;

export const DEFAULT_MISSED_JOB_STAGGER_MS = 5_000;

export const DEFAULT_MAX_MISSED_JOBS_PER_RESTART = 5;

export const DEFAULT_STARTUP_DEFERRED_MISSED_AGENT_JOB_DELAY_MS = 2 * 60_000;

export type TimedCronRunOutcome = CronJobExecutionResult & {
  jobId: string;
  job: CronJob;
  taskRunId?: string;
  completionStatus: CronCompletionStatus;
  deliveryState: CronResolvedDeliveryState;
  isolatedAgentSetupTimeout?: IsolatedAgentSetupTimeoutSignal;
  activeJobMarker?: CronActiveJobMarker;
  runReceipt?: CronRunReceiptHandle;
  runReceiptContext?: OpenClawStateWorkerContext;
  receiptSettlementDisposition?: CronRunReceiptSettlementDisposition;
  request?: {
    executionJob: CronJob;
    preserveCadence: boolean;
    scheduleOwnershipAtMs: number;
    runId?: string;
    terminalTracker?: { emitted: boolean };
  };
  startedAt: number;
  endedAt: number;
};

export type CronJobRunResult = CronRunOutcome &
  Pick<CronRunTelemetry, "provider"> &
  CronRunDeliveryResult & {
    completionStatus?: CronCompletionStatus;
    startedAt: number;
    endedAt: number;
    nextCheck?: CronNextCheckProposal;
  };

export type IsolatedAgentSetupTimeoutSignal = {
  error: string;
  timeoutMs: number;
  otherCronJobsActiveAtTimeout: boolean;
};

export type IsolatedAgentSetupTimeoutResult = {
  jobId: string;
  job: CronJob;
  isolatedAgentSetupTimeout?: IsolatedAgentSetupTimeoutSignal;
};

export type ExecuteJobCoreOptions = {
  idleAdmission?: import("./state.js").CronIdleAdmissionSource;
  waitForIdle?: import("./state.js").CronIdleAdmissionWait;
  deliveryAttemptFence?: CronCompletionDeliveryFence;
  activeJobMarker?: CronActiveJobMarker;
  onExecutionStarted?: (info?: CronAgentExecutionStarted) => void;
  onExecutionPhase?: (info: CronAgentExecutionPhaseUpdate) => void;
  onLaneWait?: (info?: { waiting?: boolean }) => void;
  executionIdentity?: import("./state.js").CronExecutionIdentityAdmission;
  /** Revalidates the durable run fence after awaited planning and before effects. */
  assertRunCurrent?: () => Promise<void>;
  streamBatch?: string;
  // Source definition and logical identity are an inseparable admission claim.
  // The key catches edits; the identity catches disable→re-enable and A→B→A.
  streamScheduleKey?: string;
  streamSourceIdentity?: string;
};

export async function resolveMainSessionCronDeliveryContext(
  state: CronServiceState,
  job: CronJob,
): Promise<DeliveryContext | undefined> {
  const targetSessionKey = job.sessionKey?.trim();
  if (!targetSessionKey) {
    return undefined;
  }
  const explicitAgentId = job.agentId?.trim();
  const agentId = normalizeAgentId(
    explicitAgentId ||
      resolveAgentIdFromSessionKey(
        targetSessionKey,
        state.deps.resolveDefaultAgentId?.() ?? state.deps.defaultAgentId,
      ),
  );
  const storePath = state.deps.resolveSessionStorePath?.(agentId) ?? state.deps.sessionStorePath;
  if (!storePath) {
    return undefined;
  }
  try {
    const sessionEntry = await readSessionEntryReadOnlyInWorker({
      agentId,
      sessionKey: targetSessionKey,
      storePath,
    });
    return deliveryContextFromSession(sessionEntry);
  } catch {
    return undefined;
  }
}
