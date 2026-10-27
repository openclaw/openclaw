import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { ReplyDispatchReceipt, ReplyDispatcher } from "./reply/reply-dispatcher.types.js";

type ReplyDispatcherSettledTask = () => Promise<void> | void;
type PendingSettledTask = { run: () => Promise<void>; settled: Promise<void> };

const settledTasksByDispatcher = resolveGlobalSingleton(
  Symbol.for("openclaw.replyDispatcherSettledTasks"),
  () => new WeakMap<ReplyDispatcher, Set<PendingSettledTask>>(),
);

/** Register post-delivery work owned by the dispatcher's settle lifecycle. */
export function registerReplyDispatcherSettledTask(
  dispatcher: ReplyDispatcher,
  task: ReplyDispatcherSettledTask,
): void {
  const tasks = settledTasksByDispatcher.get(dispatcher) ?? new Set<PendingSettledTask>();
  const settled = createDeferredCore();
  let running: Promise<void> | undefined;
  const pending: PendingSettledTask = {
    settled: settled.promise,
    run: () =>
      (running ??= Promise.resolve()
        .then(task)
        .finally(() => {
          tasks.delete(pending);
          if (tasks.size === 0 && settledTasksByDispatcher.get(dispatcher) === tasks) {
            settledTasksByDispatcher.delete(dispatcher);
          }
          settled.resolve();
        })),
  };
  tasks.add(pending);
  settledTasksByDispatcher.set(dispatcher, tasks);
}

/** Join delivery and its recording/cleanup without executing tasks in the reply owner's context. */
export async function waitForReplyDispatcherSettlement(dispatcher: ReplyDispatcher): Promise<void> {
  try {
    await dispatcher.waitForIdle();
  } finally {
    await Promise.all(
      Array.from(settledTasksByDispatcher.get(dispatcher) ?? [], (task) => task.settled),
    );
  }
}

/** Mark a dispatcher complete, wait for pending work, then run optional cleanup. */
export async function settleReplyDispatcher(params: {
  dispatcher: ReplyDispatcher;
  onSettled?: () => void | Promise<void>;
}): Promise<ReplyDispatchReceipt | undefined> {
  params.dispatcher.markComplete();
  let receipt: ReplyDispatchReceipt | void = undefined;
  const failures: unknown[] = [];
  try {
    receipt = await params.dispatcher.waitForIdle();
  } catch (error) {
    failures.push(error);
  }
  const tasks = settledTasksByDispatcher.get(params.dispatcher) ?? [];
  // Draining may reject after delivery outcomes settle; release every owner in order
  // without replacing the original error (including typed retryable no-send errors).
  for (const task of [...Array.from(tasks, (pending) => pending.run), params.onSettled]) {
    try {
      await task?.();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw failures[0];
  }
  return receipt || undefined;
}

/** Run work with a dispatcher and always drain it before returning or throwing. */
export async function withReplyDispatcher<T>(params: {
  dispatcher: ReplyDispatcher;
  run: () => Promise<T>;
  onSettled?: () => void | Promise<void>;
  onSettledReceipt?: (receipt: ReplyDispatchReceipt | undefined) => void;
}): Promise<T> {
  let run: { value: T } | { error: unknown };
  try {
    run = { value: await params.run() };
  } catch (error) {
    run = { error };
  }
  try {
    const receipt = await settleReplyDispatcher(params);
    params.onSettledReceipt?.(receipt);
  } catch (error) {
    if ("value" in run) {
      throw error;
    }
  }
  if ("error" in run) {
    throw run.error;
  }
  return run.value;
}
