/** Process-local bridge from detached media tasks to the Gateway-owned cron service. */

export type DetachedMediaCronFailureRecordRequest = {
  requesterSessionKey: string;
  taskId: string;
  runId: string;
  toolName: string;
  error: string;
};

type DetachedMediaCronFailureRecorder = (
  request: DetachedMediaCronFailureRecordRequest,
) => Promise<void> | void;

let recorder: DetachedMediaCronFailureRecorder | undefined;

export function registerDetachedMediaCronFailureRecorder(
  next: DetachedMediaCronFailureRecorder,
): () => void {
  recorder = next;
  return () => {
    if (recorder === next) {
      recorder = undefined;
    }
  };
}

export function getDetachedMediaCronFailureRecorder():
  | DetachedMediaCronFailureRecorder
  | undefined {
  return recorder;
}
