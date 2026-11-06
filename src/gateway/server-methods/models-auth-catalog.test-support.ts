import { channel } from "node:diagnostics_channel";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createDeferred } from "../../../test/helpers/promise.js";
import { getPreparedModelCatalogWorkerPoolSnapshot } from "../../agents/prepared-model-catalog-worker.js";
import { registerPreparedModelRuntimePublicationListener } from "../../agents/prepared-model-runtime.publication-events.js";

/** Observe catalog readiness through publications within the owning test's lifetime. */
export async function waitForCatalogPublication<T>(params: {
  signal: AbortSignal;
  read: () => Promise<T>;
  ready: (value: T) => boolean;
  start?: () => Promise<T>;
}): Promise<T> {
  let publication = createDeferred();
  const wake = () => publication.resolve();
  params.signal.throwIfAborted();
  params.signal.addEventListener("abort", wake, { once: true });
  const unregister = registerPreparedModelRuntimePublicationListener(({ phase }) => {
    if (phase === "catalog-published" || phase === "catalog-failed" || phase === "failed") {
      wake();
    }
  });
  try {
    let read = params.start ?? params.read;
    for (;;) {
      // Capture the signal before the RPC so a publication during the read is not missed.
      const nextPublication = publication;
      params.signal.throwIfAborted();
      const value = await read();
      read = params.read;
      params.signal.throwIfAborted();
      if (params.ready(value)) {
        return value;
      }
      await nextPublication.promise;
      publication = createDeferred();
    }
  } finally {
    unregister();
    params.signal.removeEventListener("abort", wake);
  }
}

/** Observe the real catalog pool without replacing its worker or provider requests. */
export function observeCatalogWorkerTasks() {
  let completedTasks = 0;
  const tasks = channel("openclaw.worker.task");
  const record = (message: unknown) => {
    if (
      isRecord(message) &&
      message.worker === "prepared-model-catalog.worker.js" &&
      message.outcome === "ok"
    ) {
      completedTasks++;
    }
  };
  tasks.subscribe(record);
  return {
    read: () => ({ ...getPreparedModelCatalogWorkerPoolSnapshot(), completedTasks }),
    close: () => tasks.unsubscribe(record),
  };
}
