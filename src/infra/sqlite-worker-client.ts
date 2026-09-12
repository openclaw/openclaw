import { serialize } from "node:v8";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import {
  SqliteWorkerError,
  type SqliteWorkerOperations,
  type SqliteWorkerStore,
} from "./sqlite-worker-contract.js";

export function createSqliteWorkerClient<Operations extends SqliteWorkerOperations>(owner: {
  dispatch: (payload: Buffer, signal?: AbortSignal) => Promise<unknown>;
  release: () => Promise<void>;
}): SqliteWorkerStore<Operations> {
  let closed: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  return {
    execute: (command, operationOptions = {}) => {
      if (closed) {
        return Promise.reject(new SqliteWorkerError("SQLite worker store is closed", "closed"));
      }
      if (operationOptions.signal?.aborted) {
        return Promise.reject(
          toErrorObject(operationOptions.signal.reason, "SQLite worker operation canceled"),
        );
      }
      let payload: Buffer;
      try {
        // Snapshot at admission, before a queued caller can mutate its input.
        payload = serialize(command);
      } catch (error) {
        return Promise.reject(
          toErrorObject(error, "SQLite worker command could not be serialized"),
        );
      }
      // SAFETY: The typed backend owns this result.
      const operation = owner.dispatch(payload, operationOptions.signal) as Promise<
        Operations[typeof command.type]["output"]
      >;
      pending.add(operation);
      void operation.then(
        () => pending.delete(operation),
        () => pending.delete(operation),
      );
      return operation;
    },
    close: () => {
      if (!closed) {
        closed = (async () => {
          await Promise.allSettled(pending);
          await owner.release();
        })();
      }
      return closed;
    },
  };
}
