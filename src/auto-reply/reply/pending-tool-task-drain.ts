import { logVerbose } from "../../globals.js";

/** Waits for asynchronous tool tasks before final reply delivery. */
const DEFAULT_PENDING_TOOL_DRAIN_IDLE_TIMEOUT_MS = 30_000;

type DrainOptions = {
  tasks: Set<Promise<void>>;
};

type PendingTaskObserver = { settled?: (task: Promise<void>) => void };

function observePendingTask(task: Promise<void>, observer: PendingTaskObserver): void {
  // Stuck tasks retain only this detachable observer, never the active drain's
  // task set and callbacks after its idle deadline has ended the wait.
  const settled = () => observer.settled?.(task);
  void task.then(settled, settled);
}

/** Waits for pending tool tasks to settle or times out to avoid session deadlock. */
export async function drainPendingToolTasks({ tasks }: DrainOptions): Promise<void> {
  if (tasks.size === 0) {
    return;
  }

  const observed = new WeakSet<Promise<void>>();
  const observer: PendingTaskObserver = {};
  const outcome = await new Promise<"settled" | "timeout">((resolve) => {
    const finish = (result: "settled" | "timeout") => {
      observer.settled = undefined;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => finish("timeout"), DEFAULT_PENDING_TOOL_DRAIN_IDLE_TIMEOUT_MS);
    timeout.unref?.();
    const observeNewTasks = () => {
      for (const task of tasks) {
        if (!observed.has(task)) {
          observed.add(task);
          observePendingTask(task, observer);
        }
      }
    };
    observer.settled = (task) => {
      observed.delete(task);
      tasks.delete(task);
      if (tasks.size === 0) {
        finish("settled");
      } else {
        timeout.refresh();
        observeNewTasks();
      }
    };
    observeNewTasks();
  });
  if (outcome === "timeout") {
    const remaining = tasks.size;
    logVerbose(
      `pending tool tasks made no progress within ${DEFAULT_PENDING_TOOL_DRAIN_IDLE_TIMEOUT_MS}ms; proceeding with ${remaining} task(s) still pending to avoid session deadlock`,
    );
  }
}
