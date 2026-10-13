import { threadId } from "node:worker_threads";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";

let admissionDepth = 0;

/** Main-thread SQL is limited to the synchronous boot admission or migration callback. */
export function withEngineStoreAdmission<T>(operation: () => T): T {
  admissionDepth += 1;
  try {
    const result = operation();
    if (isPromiseLike(result)) {
      throw new Error("Database engine admission must remain synchronous");
    }
    return result;
  } finally {
    admissionDepth -= 1;
  }
}

export function assertEngineStoreExecutionAllowed(): void {
  if (threadId === 0 && admissionDepth === 0) {
    throw new Error(
      "PostgreSQL connections must run in a worker; only synchronous admission and migrations may run on the main thread",
    );
  }
}
