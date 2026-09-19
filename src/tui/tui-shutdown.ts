type TuiShutdownTask = () => void | Promise<void>;

export function beginTuiShutdown(params: {
  stopCommandScopes?: TuiShutdownTask;
  stopClient: TuiShutdownTask;
  stopTui: TuiShutdownTask;
  disposeStatus: () => void;
  requestFinish: () => void;
  forceExit: () => void;
  hardExitMs: number;
  keepHardExitArmed?: boolean;
  onError: (error: unknown) => void;
}): ReturnType<typeof setTimeout> {
  const hardExitTimer = setTimeout(params.forceExit, params.hardExitMs);
  hardExitTimer.unref();
  // Stop referenced animations before transport teardown can stall or redraw.
  params.disposeStatus();
  void Promise.resolve()
    .then(async () => {
      const errors: unknown[] = [];
      const runtimeTasks = [params.stopCommandScopes, params.stopClient].map(async (task) =>
        task?.(),
      );
      for (const result of await Promise.allSettled(runtimeTasks)) {
        if (result.status === "rejected") {
          errors.push(result.reason);
        }
      }
      // Terminal ownership must be released even when transport teardown fails.
      try {
        await params.stopTui();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "TUI shutdown failed");
      }
    })
    .finally(() => {
      if (params.keepHardExitArmed !== true) {
        clearTimeout(hardExitTimer);
      }
      params.disposeStatus();
    })
    .catch(params.onError)
    .finally(params.requestFinish);

  // For the standalone command, settled teardown is not proof that runTui
  // returned. Its unref keeps clean exits fast while preserving the deadline.
  return hardExitTimer;
}
