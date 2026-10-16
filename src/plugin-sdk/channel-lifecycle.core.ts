// Channel lifecycle core contracts define account lifecycle snapshots and sync hooks.
import type { ChannelAccountSnapshot } from "../channels/plugins/types.core.js";
import { createRunStateMachine, type RunStateStatusSink } from "../channels/run-state-machine.js";
import { KeyedAsyncQueue } from "./keyed-async-queue.js";

type CloseAwareServer = {
  once: (event: "close", listener: () => void) => unknown;
};

type PassiveAccountLifecycleParams<Handle> = {
  abortSignal?: AbortSignal;
  start: () => Promise<Handle>;
  stop?: (handle: Handle) => void | Promise<void>;
  onStop?: () => void | Promise<void>;
};

/** Runtime context passed to queued channel work. */
export type ChannelRunQueueTaskContext = {
  /** Signal tied to the channel/account lifecycle that owns the queued work. */
  lifecycleSignal?: AbortSignal;
};

/** Per-key async queue used by channel plugins to serialize account or thread work. */
export type ChannelRunQueue = {
  /** Enqueue work under a serialization key such as account id, thread id, or chat id. */
  enqueue: (key: string, task: (context: ChannelRunQueueTaskContext) => Promise<void>) => void;
  /** Stop accepting meaningful work and mark the lifecycle as inactive. */
  deactivate: () => void;
};

/** Hooks used to wire channel queue state into runtime status and error reporting. */
export type ChannelRunQueueParams = {
  /** Receives busy/idle lifecycle snapshots from the shared run-state machine. */
  setStatus?: RunStateStatusSink;
  /** Lifecycle signal propagated to queued tasks. */
  abortSignal?: AbortSignal;
  /** Best-effort sink for task failures after enqueueing. */
  onError?: (error: unknown) => void;
};

/** Bind a fixed account id into a status writer so lifecycle code can emit partial snapshots. */
export function createAccountStatusSink(params: {
  accountId: string;
  setStatus: (next: ChannelAccountSnapshot) => void;
}): (patch: Omit<ChannelAccountSnapshot, "accountId">) => void {
  return (patch) => {
    params.setStatus({ accountId: params.accountId, ...patch });
  };
}

/**
 * Serialize channel work per key while keeping lifecycle/busy accounting out of
 * channel-specific message handlers. The queue does not impose run timeouts;
 * callers should rely on session/tool/runtime lifecycle for long-running work.
 */
export function createChannelRunQueue(params: ChannelRunQueueParams): ChannelRunQueue {
  const queue = new KeyedAsyncQueue();
  const runStarts = new Map<symbol, number>();
  const runState = createRunStateMachine({
    setStatus: (patch) => {
      params.setStatus?.({
        ...patch,
        activeRunStartedAt: runStarts.size > 0 ? Math.min(...runStarts.values()) : null,
      });
    },
    abortSignal: params.abortSignal,
  });

  const reportError = (error: unknown) => {
    try {
      params.onError?.(error);
    } catch {
      // Keep queue error handling best-effort; callers should not create a
      // secondary unhandled rejection from their reporting hook.
    }
  };

  return {
    enqueue(key, task) {
      void queue
        .enqueue(key, async () => {
          if (!runState.isActive()) {
            return;
          }
          const runHandle = Symbol("channel-run");
          runStarts.set(runHandle, Date.now());
          runState.onRunStart();
          try {
            // Deactivation can happen while this key waited behind older work.
            if (!runState.isActive()) {
              return;
            }
            await task({ lifecycleSignal: params.abortSignal });
          } finally {
            runStarts.delete(runHandle);
            runState.onRunEnd();
          }
        })
        .catch(reportError);
    },
    deactivate: runState.deactivate,
  };
}

async function runAbortCleanup(onAbort: (() => void | Promise<void>) | undefined): Promise<void> {
  return onAbort?.();
}

/**
 * Return a promise that resolves when the signal is aborted.
 *
 * If no signal is provided, the promise stays pending forever. When provided,
 * `onAbort` runs once before the promise resolves.
 */
export function waitUntilAbort(
  signal?: AbortSignal,
  onAbort?: () => void | Promise<void>,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const complete = () => {
      void runAbortCleanup(onAbort).then(resolve, reject);
    };
    if (!signal) {
      return;
    }
    if (signal.aborted) {
      complete();
      return;
    }
    signal.addEventListener("abort", complete, { once: true });
  });
}

/**
 * Keep a passive account task alive until abort, then run optional cleanup.
 */
export async function runPassiveAccountLifecycle<Handle>(
  params: PassiveAccountLifecycleParams<Handle>,
): Promise<void> {
  const handle = await params.start();

  try {
    await waitUntilAbort(params.abortSignal);
  } finally {
    await params.stop?.(handle);
    await params.onStop?.();
  }
}

/**
 * Keep a channel/provider task pending until the HTTP server closes.
 *
 * When an abort signal is provided, `onAbort` is invoked once and should
 * trigger server shutdown. The returned promise resolves only after `close`.
 */
export async function keepHttpServerTaskAlive(params: {
  server: CloseAwareServer;
  abortSignal?: AbortSignal;
  onAbort?: () => void | Promise<void>;
}): Promise<void> {
  const { server, abortSignal, onAbort } = params;
  // Subscribe before an already-aborted signal can synchronously close the server.
  const closed = new Promise<void>((resolve) => {
    server.once("close", () => resolve());
  });
  let abortTask: Promise<void> = Promise.resolve();
  let abortTriggered = false;

  const triggerAbort = () => {
    if (abortTriggered) {
      return;
    }
    abortTriggered = true;
    abortTask = runAbortCleanup(onAbort);
    // Cleanup can reject before close; retain that error for the task's final await.
    void abortTask.catch(() => {});
  };

  if (abortSignal) {
    if (abortSignal.aborted) {
      triggerAbort();
    } else {
      abortSignal.addEventListener("abort", triggerAbort, { once: true });
    }
  }

  await closed;
  abortSignal?.removeEventListener("abort", triggerAbort);
  await abortTask;
}
