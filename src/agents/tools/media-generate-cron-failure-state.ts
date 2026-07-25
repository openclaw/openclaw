import type { DetachedMediaCronFailureRecordRequest } from "../../cron/detached-media-failure-recorder.js";
import { getDetachedMediaCronFailureRecorder } from "../../cron/detached-media-failure-recorder.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("agents/tools/media-generate-cron-failure-state");

type MediaGenerationCronFailureHandle = {
  requesterSessionKey: string;
  taskId: string;
  runId: string;
};

export async function markOriginatingCronRunFailedFromMediaGeneration(params: {
  handle: MediaGenerationCronFailureHandle | null;
  error: unknown;
  toolName: string;
}) {
  if (!params.handle) {
    return;
  }
  const recorder = getDetachedMediaCronFailureRecorder();
  if (!recorder) {
    return;
  }
  const request: DetachedMediaCronFailureRecordRequest = {
    requesterSessionKey: params.handle.requesterSessionKey,
    taskId: params.handle.taskId,
    runId: params.handle.runId,
    toolName: params.toolName,
    error: `Detached ${params.toolName} failed: ${formatErrorMessage(params.error)}`,
  };
  try {
    await recorder(request);
  } catch (error) {
    log.warn("Failed to mark originating cron run failed after detached media generation failure", {
      requesterSessionKey: params.handle.requesterSessionKey,
      taskId: params.handle.taskId,
      runId: params.handle.runId,
      error,
    });
  }
}
