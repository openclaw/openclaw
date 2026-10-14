import { SqliteWorkerError, type SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import {
  registerOpenClawStateDatabaseAsyncResource,
  registerOpenClawStateDatabaseLifecycleListener,
} from "../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import {
  createOpenClawStateWorkerLease,
  type OpenClawStateWorkerLease,
} from "../state/openclaw-state-worker-store.js";
import { finalizeCaptureStoreAsync } from "./store-lifecycle.js";
import type { AsyncDebugProxyCaptureStore } from "./store.types.js";
import type { CaptureWorkerOperations } from "./store.worker-contract.js";

type CaptureScope = Pick<SqliteWorkerStore<CaptureWorkerOperations>, "execute">;

export async function acquireDebugProxyCaptureStoreAsync(
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<{ store: AsyncDebugProxyCaptureStore; release: () => Promise<void> }> {
  const lease = createDebugProxyCaptureStoreForContext(captureOpenClawStateWorkerContext(options));
  await lease.ready;
  return { store: lease.store, release: lease.release };
}

export function createDebugProxyCaptureStoreForContext(context: OpenClawStateWorkerContext): {
  store: AsyncDebugProxyCaptureStore;
  ready: Promise<void>;
  runOperation<T>(operation: (store: AsyncDebugProxyCaptureStore) => Promise<T>): Promise<T>;
  release: () => Promise<void>;
} {
  let closed = false;
  let closing = false;
  let completion: Promise<void> | undefined;
  let worker: OpenClawStateWorkerLease;
  const retire = async () => {
    closed = true;
    try {
      await worker.retire();
    } finally {
      unregisterResource();
      unregisterLifecycle();
    }
  };
  const unregisterResource = registerOpenClawStateDatabaseAsyncResource({
    close: async (identity) => {
      if (identity !== undefined && identity.key !== context.admission.identity.key) {
        return;
      }
      // Canonical maintenance invalidates admission; only orderly scope release
      // may finalize capture through the still-admitted logical lease.
      await retire();
    },
  });
  const unregisterLifecycle = registerOpenClawStateDatabaseLifecycleListener((event) => {
    if (event.kind !== "opened" && event.identity?.key === context.admission.identity.key) {
      void retire().catch(() => undefined);
    }
  });
  const executePublic: CaptureScope["execute"] = (command) => {
    const result =
      closed || closing
        ? Promise.reject(new SqliteWorkerError("Capture store is closed", "closed"))
        : worker.execute(command);
    // Observe abandoned callback writes while returning their rejecting Promise.
    void result.catch(() => undefined);
    return result;
  };
  const createStore = (execute: CaptureScope["execute"]): AsyncDebugProxyCaptureStore => ({
    dbPath: context.admission.databasePath,
    get isClosed() {
      if (closed) {
        return true;
      }
      try {
        context.admission.assertCurrent();
        return false;
      } catch {
        return true;
      }
    },
    upsertSession: (session) => execute({ type: "capture.upsertSession", input: { ...session } }),
    endSession: (sessionId, endedAt = Date.now()) =>
      execute({ type: "capture.endSession", input: { sessionId, endedAt } }),
    persistPayload: (data, contentType) =>
      execute({ type: "capture.persistPayload", input: { data: Buffer.from(data), contentType } }),
    recordEvent: (event) => execute({ type: "capture.recordEvent", input: { ...event } }),
    recordEventWithPayload: (event, payload) =>
      execute({
        type: "capture.recordEventWithPayload",
        input: {
          event: { ...event },
          payload: {
            ...payload,
            data: Buffer.isBuffer(payload.data) ? Buffer.from(payload.data) : payload.data,
          },
        },
      }),
    listSessions: (limit) => execute({ type: "capture.listSessions", input: { limit } }),
    getSessionEvents: (sessionId, limit) =>
      execute({ type: "capture.getSessionEvents", input: { sessionId, limit } }),
    summarizeSessionCoverage: (sessionId) =>
      execute({ type: "capture.summarizeSessionCoverage", input: { sessionId } }),
    readBlob: (blobId) => execute({ type: "capture.readBlob", input: { blobId } }),
    queryPreset: (preset, sessionId) =>
      execute({ type: "capture.queryPreset", input: { preset, sessionId } }),
    deleteSessions: (sessionIds) =>
      execute({ type: "capture.deleteSessions", input: { sessionIds: [...sessionIds] } }),
    purgeAll: () => execute({ type: "capture.purgeAll", input: undefined }),
    close: () => {
      closing = true;
      return (completion ??= worker.release());
    },
  });
  const store = createStore(executePublic);
  try {
    worker = createOpenClawStateWorkerLease(context, async (scope) => {
      closing = true;
      try {
        await finalizeCaptureStoreAsync(store, createStore(scope.execute));
      } finally {
        closed = true;
        unregisterResource();
        unregisterLifecycle();
      }
    });
  } catch (error) {
    unregisterResource();
    unregisterLifecycle();
    throw error;
  }
  const ready = worker.ready.then(() => {
    context.admission.assertCurrent();
    if (closed) {
      throw new SqliteWorkerError("Capture store is closed", "closed");
    }
  });
  void ready.catch(() => {
    unregisterResource();
    unregisterLifecycle();
  });
  return {
    store,
    ready,
    runOperation: (operation) =>
      worker.runOperation((scope) => operation(createStore(scope.execute))),
    release: () => store.close(),
  };
}
