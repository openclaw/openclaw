import { MessageChannel, type Worker } from "node:worker_threads";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Slot } from "./worker-task-pool.types.js";

type WorkerResourceClosures = {
  pending: number;
  exit?: { waiters: Set<() => void>; receive: () => void };
};

/** Keep each pool slot referenced until its resource cleanup settles. */
export async function closeWorkerPoolResources<Input, Output>(
  slots: ReadonlySet<Slot<Input, Output>>,
  resourceClosures: WeakMap<Worker, WorkerResourceClosures>,
  key?: string,
): Promise<void> {
  const results = await Promise.allSettled(
    [...slots].map((slot) => {
      if (slot.retiring) {
        return slot.retiring;
      }
      const worker = slot.worker;
      if (!worker) {
        return Promise.resolve();
      }
      const closure = resourceClosures.get(worker) ?? { pending: 0 };
      closure.pending += 1;
      resourceClosures.set(worker, closure);
      worker.ref();
      return closeWorkerTaskResources(worker, closure, () => slot.retiring, key).finally(() => {
        closure.pending -= 1;
        if (!closure.pending && !slot.task && !slot.retiring) {
          worker.unref();
        }
      });
    }),
  );
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) {
    throw new AggregateError(errors, "Worker resource cleanup failed");
  }
}

/** Concurrent resource closes share one listener, retained only until their last receipt. */
function observeResourceWorkerExit(
  worker: Worker,
  closures: WorkerResourceClosures,
  finish: () => void,
): () => void {
  let exit = closures.exit;
  if (!exit) {
    const waiters = new Set<() => void>();
    exit = {
      waiters,
      receive: () => {
        for (const waiter of waiters) {
          waiter();
        }
      },
    };
    closures.exit = exit;
    worker.once("exit", exit.receive);
  }
  exit.waiters.add(finish);
  return () => {
    exit.waiters.delete(finish);
    if (exit.waiters.size === 0) {
      worker.removeListener("exit", exit.receive);
      if (closures.exit === exit) {
        closures.exit = undefined;
      }
    }
  };
}

/** The pool keeps the Worker referenced until its cleanup receipt or confirmed native exit. */
function closeWorkerTaskResources(
  worker: Worker,
  closures: WorkerResourceClosures,
  readRetirement: () => Promise<void> | undefined,
  key?: string,
): Promise<void> {
  const { port1, port2 } = new MessageChannel();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      stopObservingExit();
      port1.close();
      port2.close();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    // Confirmed native exit also releases every resource owned by this Worker.
    const stopObservingExit = observeResourceWorkerExit(worker, closures, () => finish());
    port1.once("message", (reply: unknown) => {
      finish(
        isRecord(reply) && reply.ok === true
          ? undefined
          : new Error(
              isRecord(reply) && typeof reply.error === "string"
                ? reply.error
                : "Invalid worker resource cleanup receipt",
            ),
      );
    });
    port1.once("messageerror", (error) =>
      finish(toErrorObject(error, "Worker resource cleanup receipt could not be decoded")),
    );
    port1.once("close", () => {
      if (settled) {
        return;
      }
      // Termination can close the transferred port before Worker.exit arrives.
      // Only this slot's existing retirement can replace its missing receipt.
      const retirement = readRetirement();
      if (retirement) {
        void retirement.then(
          () => finish(),
          (error: unknown) =>
            finish(toErrorObject(error, "Worker resource cleanup retirement failed")),
        );
      } else {
        finish(new Error("Worker resource cleanup closed without a receipt"));
      }
    });
    try {
      worker.postMessage({ closeResource: true, key, resourcePort: port2 }, [port2]);
    } catch (error) {
      finish(toErrorObject(error, "Worker resource cleanup could not be sent"));
    }
  });
}
