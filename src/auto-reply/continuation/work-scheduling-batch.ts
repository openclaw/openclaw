import type { TaskFlowRecord } from "../../tasks/task-flow-registry.types.js";
import type {
  ContinuationWorkBatchParams,
  ContinuationWorkBatchResult,
  ContinuationWorkScheduleParams,
  ContinuationWorkScheduleResult,
} from "./types.js";
import {
  buildContinuationWorkBatchFailure,
  prepareContinuationWorkBatchReplacement,
} from "./work-scheduling-replacement.js";

export async function scheduleContinuationWorkBatchWith(
  params: ContinuationWorkBatchParams,
  scheduleWork: (params: ContinuationWorkScheduleParams) => Promise<ContinuationWorkScheduleResult>,
): Promise<ContinuationWorkBatchResult> {
  let chainState = params.chainState;
  let scheduledCount = 0;
  let supersededFlows: readonly TaskFlowRecord[] | undefined;
  const { priorParkedFlows, expectedRunningFlowIds } =
    prepareContinuationWorkBatchReplacement(params);
  const replacePriorParkedWork =
    params.priorParkedFlowsToSupersede !== undefined || params.coalescePriorParkedWork !== false;
  for (const request of params.requests) {
    if (params.abortSignal?.aborted) {
      return {
        scheduledCount,
        cappedCount: params.requests.length - scheduledCount,
        capped: false,
        chainState,
        ...(supersededFlows ? { supersededFlows } : {}),
      };
    }
    const result = await scheduleWork({
      sessionKey: params.sessionKey,
      chainState,
      request,
      config: params.config,
      ...(params.parentRunId !== undefined ? { parentRunId: params.parentRunId } : {}),
      ...(params.originRunId !== undefined ? { originRunId: params.originRunId } : {}),
      ...(params.originTurnId !== undefined ? { originTurnId: params.originTurnId } : {}),
      replaceQueuedTurnEndParkedWork: scheduledCount === 0 && replacePriorParkedWork,
      expectedRunningFlowIds,
      ...(scheduledCount === 0 && priorParkedFlows.length > 0
        ? { priorParkedFlowsToSupersede: priorParkedFlows }
        : {}),
      ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
      ...(params.onFlowEnqueued ? { onFlowEnqueued: params.onFlowEnqueued } : {}),
      ...(params.log ? { log: params.log } : {}),
    });
    if (!result.scheduled) {
      return buildContinuationWorkBatchFailure({
        result,
        scheduledCount,
        requestCount: params.requests.length,
        chainState,
        ...(supersededFlows ? { supersededFlows } : {}),
      });
    }
    supersededFlows ??= result.supersededFlows;
    chainState = result.chainState;
    scheduledCount += 1;
  }
  return {
    scheduledCount,
    cappedCount: 0,
    capped: false,
    chainState,
    ...(supersededFlows ? { supersededFlows } : {}),
  };
}
