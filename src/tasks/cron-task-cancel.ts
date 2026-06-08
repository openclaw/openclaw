// Process-local cancellation handles for live cron task runs.

type CronTaskCancelHandle = {
  controller: AbortController;
  onCancel?: (reason: string) => void;
};

const activeCronTaskRunsByRunId = new Map<string, CronTaskCancelHandle>();

export function registerActiveCronTaskRun(params: {
  runId: string | undefined;
  controller: AbortController;
  onCancel?: (reason: string) => void;
}): (() => void) | undefined {
  const runId = params.runId?.trim();
  if (!runId) {
    return undefined;
  }
  activeCronTaskRunsByRunId.set(runId, {
    controller: params.controller,
    onCancel: params.onCancel,
  });
  return () => {
    if (activeCronTaskRunsByRunId.get(runId)?.controller === params.controller) {
      activeCronTaskRunsByRunId.delete(runId);
    }
  };
}

export function cancelActiveCronTaskRun(params: {
  runId: string | undefined;
  reason?: string;
}): boolean {
  const runId = params.runId?.trim();
  if (!runId) {
    return false;
  }
  const handle = activeCronTaskRunsByRunId.get(runId);
  if (!handle) {
    return false;
  }
  if (handle.controller.signal.aborted) {
    return false;
  }
  const reason = params.reason?.trim() || "Cancelled by operator.";
  handle.controller.abort(reason);
  handle.onCancel?.(reason);
  return true;
}

export function resetActiveCronTaskRunsForTests(): void {
  activeCronTaskRunsByRunId.clear();
}
