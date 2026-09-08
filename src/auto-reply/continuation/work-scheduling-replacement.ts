import type { TaskFlowRecord } from "../../tasks/task-flow-registry.types.js";
import type {
  ContinuationWorkBatchParams,
  ContinuationWorkBatchResult,
  ContinuationWorkScheduleParams,
  ContinuationWorkScheduleResult,
} from "./types.js";
import type { PendingContinuationWork } from "./work-flow-state.js";
import {
  enqueuePendingWorkReplacing,
  listQueuedTurnEndParkedWork,
  listRunningContinuationWorkIds,
} from "./work-replacement-store.js";

type ScheduledWorkEnqueueResult =
  | {
      scheduled: true;
      work: PendingContinuationWork;
      supersededFlows: readonly TaskFlowRecord[];
    }
  | Extract<ContinuationWorkScheduleResult, { scheduled: false }>;

export function enqueueContinuationWorkForSchedule(params: {
  work: PendingContinuationWork;
  schedule: Pick<
    ContinuationWorkScheduleParams,
    | "chainState"
    | "config"
    | "expectedRunningFlowIds"
    | "log"
    | "priorParkedFlowsToSupersede"
    | "replaceQueuedTurnEndParkedWork"
    | "sessionKey"
  >;
}): ScheduledWorkEnqueueResult {
  return enqueueContinuationWorkAtomically(params);
}

function enqueueContinuationWorkAtomically(params: {
  work: PendingContinuationWork;
  schedule: Pick<
    ContinuationWorkScheduleParams,
    | "chainState"
    | "config"
    | "expectedRunningFlowIds"
    | "log"
    | "priorParkedFlowsToSupersede"
    | "replaceQueuedTurnEndParkedWork"
    | "sessionKey"
  >;
}): ScheduledWorkEnqueueResult {
  const replacement = enqueuePendingWorkReplacing({
    work: params.work,
    summary: "Superseded by a newer continue_work election after its replacement became durable.",
    maxPendingWork: params.schedule.config.maxPendingWork,
    replaceParkedWork: params.schedule.replaceQueuedTurnEndParkedWork !== false,
    expectedPriorFlowIds:
      params.schedule.priorParkedFlowsToSupersede?.map((flow) => flow.flowId) ?? [],
    expectedRunningFlowIds:
      params.schedule.expectedRunningFlowIds ??
      listRunningContinuationWorkIds(params.schedule.sessionKey),
  });
  if (!replacement.applied) {
    if (replacement.capped) {
      return { scheduled: false, capped: true, chainState: params.schedule.chainState };
    }
    params.schedule.log?.(
      `[continuation:work-replacement-not-committed] session=${params.schedule.sessionKey} reason=${replacement.reason}${replacement.flowId ? ` flowId=${replacement.flowId}` : ""}`,
    );
    return {
      scheduled: false,
      capped: false,
      chainState: params.schedule.chainState,
      replacementFailure: replacement.reason,
      ...(replacement.flowId ? { replacementFailureFlowId: replacement.flowId } : {}),
    };
  }
  params.schedule.log?.(
    `[continuation:work-turn-end-parked-coalesced] session=${params.schedule.sessionKey} folded=${replacement.supersededFlows.length}`,
  );
  return {
    scheduled: true,
    work: replacement.work,
    supersededFlows: replacement.supersededFlows,
  };
}

export function prepareContinuationWorkBatchReplacement(params: ContinuationWorkBatchParams): {
  priorParkedFlows: readonly TaskFlowRecord[];
  expectedRunningFlowIds: readonly string[];
} {
  const priorParkedFlows =
    params.priorParkedFlowsToSupersede ??
    (params.coalescePriorParkedWork === false
      ? []
      : listQueuedTurnEndParkedWork(params.sessionKey));
  if (priorParkedFlows.length === 0) {
    return {
      priorParkedFlows,
      expectedRunningFlowIds:
        params.expectedRunningFlowIds ?? listRunningContinuationWorkIds(params.sessionKey),
    };
  }

  return {
    priorParkedFlows,
    expectedRunningFlowIds:
      params.expectedRunningFlowIds ?? listRunningContinuationWorkIds(params.sessionKey),
  };
}

export function buildContinuationWorkBatchFailure(input: {
  result: Extract<ContinuationWorkScheduleResult, { scheduled: false }>;
  scheduledCount: number;
  requestCount: number;
  chainState: ContinuationWorkBatchResult["chainState"];
  supersededFlows?: readonly TaskFlowRecord[];
}): ContinuationWorkBatchResult {
  return {
    scheduledCount: input.scheduledCount,
    cappedCount: input.requestCount - input.scheduledCount,
    capped: input.result.capped,
    chainState: input.chainState,
    ...(input.result.replacementFailure
      ? { replacementFailure: input.result.replacementFailure }
      : {}),
    ...(input.result.replacementFailureFlowId
      ? { replacementFailureFlowId: input.result.replacementFailureFlowId }
      : {}),
    ...(input.supersededFlows ? { supersededFlows: input.supersededFlows } : {}),
  };
}
