// Process-local cancellation handles for live cron task runs.

type CronTaskCancelHandle = {
  controller: AbortController;
};

const activeCronTaskRunsByRunId = new Map<string, CronTaskCancelHandle>();

export function registerActiveCronTaskRun(params: {
  runId: string | undefined;
  controller: AbortController;
}): (() => void) | undefined {
  const runId = params.runId?.trim();
  if (!runId) {
    return undefined;
  }
  activeCronTaskRunsByRunId.set(runId, { controller: params.controller });
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
  if (!handle.controller.signal.aborted) {
    handle.controller.abort(params.reason?.trim() || "Cancelled by operator.");
  }
  return true;
}

export function resetActiveCronTaskRunsForTests(): void {
  activeCronTaskRunsByRunId.clear();
}
