type TuiShutdownTask = () => void | Promise<void>;

export async function beginTuiShutdown(params: {
  stopCommandScopes?: TuiShutdownTask;
  stopClient: TuiShutdownTask;
  stopTui: TuiShutdownTask;
  disposeStatus: () => void;
  requestFinish: () => void;
  onError: (error: unknown) => void;
}): Promise<void> {
  // Stop referenced animations before transport teardown can stall or redraw.
  params.disposeStatus();
  try {
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
  } catch (error) {
    params.onError(error);
  } finally {
    params.disposeStatus();
    params.requestFinish();
  }
}
