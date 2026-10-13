import { vi } from "vitest";
import * as workerContext from "../state/openclaw-state-worker-context.js";
import { finalizeCaptureStoreAsync } from "./store-lifecycle.js";
import * as captureStore from "./store.async.js";
import type { AsyncDebugProxyCaptureStore } from "./store.types.js";
import type { CaptureEventRecord } from "./types.js";

/** Keep the real capture/body pipeline while replacing only its persistence boundary. */
export function installDebugProxyCaptureWriter(onEvent: (event: CaptureEventRecord) => void): void {
  vi.spyOn(workerContext, "captureOpenClawStateWorkerContext").mockReturnValue({
    admission: {
      coordinationKey: "synthetic",
      databasePath: "/synthetic/state.sqlite",
      identity: { key: "synthetic", canonicalPath: "/synthetic/state.sqlite" },
      assertCurrent() {},
    },
    environment: { OPENCLAW_STATE_DIR: "/synthetic" },
  });
  vi.spyOn(captureStore, "createDebugProxyCaptureStoreForContext").mockImplementation(() => {
    let closed = false;
    let closing: Promise<void> | undefined;
    const unused = async (): Promise<never> => {
      throw new Error("Unexpected read from capture writer fixture");
    };
    const store: AsyncDebugProxyCaptureStore = {
      dbPath: "/synthetic/state.sqlite",
      get isClosed() {
        return closed;
      },
      upsertSession: async () => {},
      endSession: async () => {},
      recordEvent: async (event) => {
        onEvent(event);
      },
      recordEventWithPayload: async (event, { data, contentType }) => {
        onEvent({
          ...event,
          contentType,
          ...(Buffer.isBuffer(data)
            ? { dataText: data.toString("utf8") }
            : typeof data === "string"
              ? { dataText: data }
              : {}),
        });
      },
      persistPayload: unused,
      listSessions: unused,
      getSessionEvents: unused,
      summarizeSessionCoverage: unused,
      readBlob: unused,
      queryPreset: unused,
      deleteSessions: unused,
      purgeAll: unused,
      close: () =>
        (closing ??= Promise.resolve().then(async () => {
          await finalizeCaptureStoreAsync(store, store);
          closed = true;
        })),
    };
    return {
      store,
      ready: Promise.resolve(),
      runOperation: (operation) => operation(store),
      release: () => store.close(),
    };
  });
}
