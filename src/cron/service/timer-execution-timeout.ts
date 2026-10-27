import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.read.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { CronActiveJobMarker } from "../active-jobs.js";
import type { CronCompletionDeliveryFence } from "../delivery-attempt-fence.js";
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
import type { CronIdleAdmissionSource, CronIdleAdmissionWait, CronServiceState } from "./state.js";

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
  request?: {
    executionJob: CronJob;
    preserveCadence: boolean;
    onExitWatcherCompletion?: boolean;
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
  /** Queue admission supplies this fact so receipt I/O cannot reorder payload starts. */
  migrationPending?: boolean;
  idleAdmission?: CronIdleAdmissionSource;
  waitForIdle?: CronIdleAdmissionWait;
  deliveryAttemptFence?: CronCompletionDeliveryFence;
  activeJobMarker?: CronActiveJobMarker;
  onExecutionStarted?: (info?: CronAgentExecutionStarted) => void;
  onExecutionPhase?: (info: CronAgentExecutionPhaseUpdate) => void;
  onLaneWait?: (info?: { waiting?: boolean }) => void;
  executionIdentity?: import("./state.js").CronExecutionIdentityAdmission;
  /** Revalidates live Gateway admission after awaited planning and before effects. */
  assertRunCurrent?: () => Promise<void>;
  streamBatch?: string;
  // Source definition and logical identity are an inseparable admission claim.
  // The key catches edits; the identity catches disable→re-enable and A→B→A.
  streamScheduleKey?: string;
  streamSourceIdentity?: string;
};

/** Payloads that execute outside the main session own cancellable task-run state. */
export function runsDetachedFromMainSession(job: CronJob): boolean {
  return job.sessionTarget !== "main" || job.payload.kind === "script";
}

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
      projection: "list",
    });
    return deliveryContextFromSession(sessionEntry);
  } catch {
    return undefined;
  }
}
