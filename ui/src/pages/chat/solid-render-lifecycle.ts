import { createEffect, createSignal, onCleanup, untrack, type Accessor } from "@solidjs/signals";
import { createParkedProjection } from "../../lib/reactive/parked-projection.ts";
import {
  type AfterCommitEffect,
  notifyRenderLifecycleForTest,
  type RenderLifecycle,
} from "./render-lifecycle.ts";

export type SolidRenderLifecycle<T> = RenderLifecycle & {
  readonly snapshot: Accessor<T>;
  readonly commitGeneration: number;
  /** The next committed DOM, followed by a browser frame; not child/overlay settlement. */
  afterLayout(effect: AfterCommitEffect, onCancel?: () => void): () => void;
};

type CommitTask = {
  generation: number;
  phase: "commit" | "layout";
  started: boolean;
  run(this: void): void;
  cancel(this: void): void;
};

/** Create inside the pane's Solid owner. Domain state and frame coalescing stay with their owners. */
export function createSolidRenderLifecycle<T>(options: {
  host: object;
  presented: () => boolean;
  read: () => T;
}): SolidRenderLifecycle<T> {
  let disposed = false;
  let requestedGeneration = 0;
  let committedRequest = -1;
  let commitGeneration = 0;
  let layoutFrame: number | undefined;
  const tasks = new Set<CommitTask>();
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const frame = createParkedProjection(
    () => ({ generation: revision(), value: options.read() }),
    options.presented,
  );

  const invalidate = () => {
    if (disposed) {
      return;
    }
    requestedGeneration += 1;
    setRevision(requestedGeneration);
    if (untrack(options.presented)) {
      notifyRenderLifecycleForTest(options.host, "invalidate");
    }
  };

  const enqueue = (
    phase: CommitTask["phase"],
    effect: AfterCommitEffect,
    onCancel?: () => void,
  ): (() => void) => {
    if (disposed) {
      onCancel?.();
      return () => {};
    }
    let cleanup: (() => void) | undefined;
    const complete = () => {
      if (!tasks.delete(task)) {
        return;
      }
      const release = cleanup;
      cleanup = undefined;
      release?.();
    };
    const task: CommitTask = {
      generation: requestedGeneration + 1,
      phase,
      started: false,
      run() {
        if (!tasks.has(task)) {
          return;
        }
        task.started = true;
        try {
          const nextCleanup = effect(complete);
          if (typeof nextCleanup === "function") {
            // Completion or disposal can happen inside the callback itself.
            if (tasks.has(task) && !disposed) {
              cleanup = nextCleanup;
            } else {
              nextCleanup();
            }
          } else {
            complete();
          }
        } catch (error) {
          complete();
          throw error;
        }
      },
      cancel() {
        if (!tasks.delete(task)) {
          return;
        }
        try {
          cleanup?.();
        } finally {
          cleanup = undefined;
          if (!task.started) {
            onCancel?.();
          }
        }
      },
    };
    tasks.add(task);
    invalidate();
    return task.cancel;
  };

  const runTasks = (phase: CommitTask["phase"]) => {
    for (const task of Array.from(tasks)) {
      if (disposed || !untrack(options.presented)) {
        break;
      }
      if (!task.started && task.phase === phase && task.generation <= committedRequest) {
        task.run();
      }
    }
  };
  const cancelLayoutFrame = () => {
    if (layoutFrame !== undefined) {
      cancelAnimationFrame(layoutFrame);
      layoutFrame = undefined;
    }
  };

  onCleanup(() => {
    disposed = true;
    cancelLayoutFrame();
    for (const task of Array.from(tasks)) {
      task.cancel();
    }
  });
  createEffect(
    () => ({ frame: frame(), presented: options.presented() }),
    (next) => {
      if (!next.presented) {
        cancelLayoutFrame();
        // Pending work waits for reveal; already-started foreground work retires.
        for (const task of Array.from(tasks)) {
          if (task.started) {
            task.cancel();
          }
        }
        return;
      }
      committedRequest = next.frame.generation;
      commitGeneration += 1;
      notifyRenderLifecycleForTest(options.host, "commit");
      runTasks("commit");
      if (
        layoutFrame === undefined &&
        Array.from(tasks).some(
          (task) => !task.started && task.phase === "layout" && task.generation <= committedRequest,
        )
      ) {
        layoutFrame = requestAnimationFrame(() => {
          layoutFrame = undefined;
          runTasks("layout");
        });
      }
    },
  );

  return {
    snapshot: () => frame().value,
    get commitGeneration() {
      return commitGeneration;
    },
    invalidate,
    afterCommit: (effect, onCancel) => enqueue("commit", effect, onCancel),
    afterLayout: (effect, onCancel) => enqueue("layout", effect, onCancel),
  };
}
