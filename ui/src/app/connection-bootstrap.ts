/** Coordinates automatic Control UI bootstrap work for one Gateway connection epoch. */
import { createDeferredCore } from "../../../src/shared/deferred.js";

export type ConnectionBootstrapCoordinator = {
  reset: () => void;
  run: (
    key: string | object,
    task: () => Promise<unknown>,
    options?: { background?: boolean },
  ) => Promise<void>;
  synchronize: (params: { client: object | null; connected: boolean }) => void;
  /** Undefined is unresolved native navigation; null leaves background work unblocked. */
  setForegroundRoute: (sessionKey: string | null | undefined) => void;
  setForegroundPane: (
    owner: object,
    state: { sessionKey: string; client: object | null; ready: boolean } | null,
  ) => void;
};

const MAX_CONNECTION_BOOTSTRAP_CONCURRENCY = 2;

type QueuedBootstrapTask = {
  promise: Promise<void>;
  background: boolean;
  started: boolean;
  resolve: () => void;
  run: () => Promise<unknown>;
};

/** Owns the queue and revokes pending work synchronously with its connection epoch. */
export function createConnectionBootstrapCoordinator(): ConnectionBootstrapCoordinator {
  let client: object | null = null;
  let generation = 0;
  let active = 0;
  let foregroundRoute: string | null | undefined = null;
  let foregroundPane:
    | { owner: object; sessionKey: string; client: object | null; ready: boolean }
    | undefined;
  const tasks = new Map<string | object, QueuedBootstrapTask>();

  const drain = () => {
    // The map owns both ordering and deduplication; route prerequisites can pass held bulk jobs.
    for (const [key, task] of tasks) {
      if (!client || active >= MAX_CONNECTION_BOOTSTRAP_CONCURRENCY) {
        return;
      }
      const foregroundPending =
        foregroundRoute !== null &&
        (!foregroundPane?.ready ||
          foregroundPane.client !== client ||
          foregroundPane.sessionKey !== foregroundRoute);
      if (task.started || (foregroundPending && task.background)) {
        continue;
      }
      task.started = true;
      active++;
      const taskGeneration = generation;
      const finish = () => {
        if (taskGeneration === generation) {
          tasks.delete(key);
          active--;
        }
        task.resolve();
        if (taskGeneration === generation) {
          drain();
        }
      };
      try {
        void task.run().then(finish, finish);
      } catch {
        finish();
      }
    }
  };

  const reset = () => {
    generation += 1;
    client = null;
    active = 0;
    foregroundPane = undefined;
    for (const task of tasks.values()) {
      if (!task.started) {
        task.resolve();
      }
    }
    tasks.clear();
  };

  return {
    reset,
    synchronize(params) {
      const nextClient = params.connected ? params.client : null;
      if (!nextClient || (client && client !== nextClient)) {
        reset();
      }
      client = nextClient;
      drain();
    },
    setForegroundRoute(sessionKey) {
      foregroundRoute = sessionKey;
      drain();
    },
    setForegroundPane(owner, state) {
      if (state && (foregroundRoute === undefined || state.sessionKey === foregroundRoute)) {
        foregroundPane = { owner, ...state };
      } else if (!state && foregroundPane?.owner === owner) {
        foregroundPane = undefined;
      }
      drain();
    },
    run(key, task, options) {
      const current = tasks.get(key);
      if (current) {
        return current.promise;
      }
      const completion = createDeferredCore();
      tasks.set(key, {
        ...completion,
        run: task,
        started: false,
        background: options?.background === true,
      });
      drain();
      return completion.promise;
    },
  };
}
