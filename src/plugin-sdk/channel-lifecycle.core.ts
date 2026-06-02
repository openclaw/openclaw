import type { ChannelAccountSnapshot } from "../channels/plugins/types.core.js";
import { createRunStateMachine, type RunStateStatusSink } from "../channels/run-state-machine.js";
import { KeyedAsyncQueue } from "./keyed-async-queue.js";

type CloseAwareServer = {
  once: (event: "close", listener: () => void) => unknown;
};

type PassiveAccountLifecycleParams<Handle> = {
  /** Shared lifecycle signal; abort keeps start/stop ordering deterministic. */
  abortSignal?: AbortSignal;
  /** Starts the passive resource and returns the handle later passed to stop. */
  start: () => Promise<Handle>;
  /** Stops the handle returned by start after lifecycle abort. */
  stop?: (handle: Handle) => void | Promise<void>;
  /** Runs after stop, even when no stop hook is configured. */
  onStop?: () => void | Promise<void>;
};

export type ChannelRunQueueTaskContext = {
  /** Lifecycle signal forwarded to queued handlers so they can stop cooperatively. */
  lifecycleSignal?: AbortSignal;
};

export type ChannelRunQueue = {
  /** Enqueue one task behind other tasks with the same key. */
  enqueue: (key: string, task: (context: ChannelRunQueueTaskContext) => Promise<void>) => void;
  /** Stop accepting useful work and clear busy/heartbeat status accounting. */
  deactivate: () => void;
};

export type ChannelRunQueueParams = {
  /** Receives busy/active-run patches from the shared run-state machine. */
  setStatus?: RunStateStatusSink;
  /** Deactivates the run queue and is forwarded to task contexts. */
  abortSignal?: AbortSignal;
  /** Best-effort reporting hook for task failures and reporter-safe queue errors. */
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
  const runState = createRunStateMachine({
    setStatus: params.setStatus,
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
          runState.onRunStart();
          try {
            if (!runState.isActive()) {
              return;
            }
            await task({ lifecycleSignal: params.abortSignal });
          } finally {
            runState.onRunEnd();
          }
        })
        .catch(reportError);
    },
    deactivate: runState.deactivate,
  };
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
      Promise.resolve(onAbort?.()).then(() => resolve(), reject);
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
  /** Server-like object that emits close exactly once when shutdown completes. */
  server: CloseAwareServer;
  /** Optional lifecycle signal that should trigger graceful server shutdown. */
  abortSignal?: AbortSignal;
  /** Invoked once on lifecycle abort; should call close/shutdown on the server. */
  onAbort?: () => void | Promise<void>;
}): Promise<void> {
  const { server, abortSignal, onAbort } = params;
  let abortTask: Promise<void> = Promise.resolve();
  let abortTriggered = false;

  const triggerAbort = () => {
    if (abortTriggered) {
      return;
    }
    abortTriggered = true;
    abortTask = Promise.resolve(onAbort?.()).then(() => undefined);
  };

  const onAbortSignal = () => {
    triggerAbort();
  };

  if (abortSignal) {
    if (abortSignal.aborted) {
      triggerAbort();
    } else {
      abortSignal.addEventListener("abort", onAbortSignal, { once: true });
    }
  }

  await new Promise<void>((resolve) => {
    server.once("close", () => resolve());
  });

  if (abortSignal) {
    abortSignal.removeEventListener("abort", onAbortSignal);
  }
  await abortTask;
}
