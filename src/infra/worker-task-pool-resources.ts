import { MessageChannel, type Worker } from "node:worker_threads";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Slot } from "./worker-task-pool.types.js";

/** Keep each pool slot referenced until its resource cleanup settles. */
export async function closeWorkerPoolResources<Input, Output>(
  slots: ReadonlySet<Slot<Input, Output>>,
  resourceClosures: WeakMap<Worker, { pending: number }>,
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
      return closeWorkerTaskResources(worker, key).finally(() => {
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

/** The pool keeps the Worker referenced until its cleanup receipt or confirmed native exit. */
function closeWorkerTaskResources(worker: Worker, key?: string): Promise<void> {
  const { port1, port2 } = new MessageChannel();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      worker.removeListener("exit", exited);
      port1.close();
      port2.close();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    // Confirmed native exit also releases every resource owned by this Worker.
    const exited = () => finish();
    worker.once("exit", exited);
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
    port1.once("close", () =>
      finish(new Error("Worker resource cleanup closed without a receipt")),
    );
    try {
      worker.postMessage({ closeResource: true, key, resourcePort: port2 }, [port2]);
    } catch (error) {
      finish(toErrorObject(error, "Worker resource cleanup could not be sent"));
    }
  });
}
