import { expect, it, vi } from "vitest";
import { collectNestedErrorCandidates } from "../infra/error-graph-internal.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { resolveDebugProxySettings } from "./env.js";
import { captureHttpExchangeAsync, finalizeDebugProxyCaptureAsync } from "./runtime.js";
import type { CaptureEventRecord } from "./types.js";

const fixture = vi.hoisted(() => ({
  retired: false,
  acquisitions: 0,
  endSessions: 0,
  terminalWrites: 0,
  events: [] as CaptureEventRecord[],
  lostTerminal: new Error("Retired capture lost its terminal write"),
  requestAccepted: undefined as (() => void) | undefined,
}));

vi.mock("../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: (): OpenClawStateWorkerContext => ({
    admission: {
      coordinationKey: "synthetic-capture",
      databasePath: "/synthetic/capture.sqlite",
      identity: { key: "synthetic-capture", canonicalPath: "/synthetic/capture.sqlite" },
      assertCurrent: () => {},
    },
    environment: { OPENCLAW_STATE_DIR: "/synthetic" },
  }),
}));

vi.mock("../state/openclaw-state-db-async-lifecycle.js", () => ({
  getOpenClawDatabaseMaintenanceScope: () => undefined,
}));

vi.mock("./store.sqlite.js", () => ({
  getDebugProxyCaptureStore: () => {
    throw new Error("Retired capture must not acquire a synchronous store");
  },
  persistEventPayload: () => {
    throw new Error("Retired capture must not persist synchronously");
  },
  safeJsonString: JSON.stringify,
}));

// mock-isolation: Drive retirement and lost terminal writes without opening a capture database.
vi.mock("./store.async.js", () => ({
  createDebugProxyCaptureStoreForContext: () => {
    fixture.acquisitions += 1;
    const record = async (event: CaptureEventRecord) => {
      if (fixture.retired) {
        fixture.terminalWrites += 1;
        throw fixture.lostTerminal;
      }
      fixture.events.push(event);
      fixture.requestAccepted?.();
    };
    const release = async () => {
      expect(fixture.retired, "canonical retirement precedes lease release").toBe(true);
    };
    const store = {
      dbPath: "/synthetic/capture.sqlite",
      get isClosed() {
        return fixture.retired;
      },
      recordEvent: record,
      recordEventWithPayload: record,
      endSession: async () => {
        fixture.endSessions += 1;
        throw fixture.lostTerminal;
      },
      close: release,
    };
    return {
      store,
      ready: Promise.resolve(),
      runOperation: <T>(operation: (scope: typeof store) => Promise<T>) => operation(store),
      release,
    };
  },
}));

it("settles accepted capture and reports lost terminal writes after canonical retirement", async () => {
  const requestAccepted = createDeferredCore();
  fixture.requestAccepted = requestAccepted.resolve;
  const settings = {
    ...resolveDebugProxySettings({ OPENCLAW_STATE_DIR: "/synthetic" }),
    enabled: true,
    sessionId: "retired-capture",
  };
  const response = new Response(new ReadableStream<Uint8Array>());
  const capturing = captureHttpExchangeAsync(
    { url: "https://capture.invalid", method: "GET", response },
    settings,
  );
  const settled = vi.fn();
  void capturing.then(settled, settled);

  try {
    await requestAccepted.promise;
    expect(fixture.events).toMatchObject([{ kind: "request" }]);
    expect(settled).not.toHaveBeenCalled();
    fixture.retired = true;

    const finalizationError = await finalizeDebugProxyCaptureAsync(settings).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(finalizationError).toBeInstanceOf(AggregateError);
    expect(collectNestedErrorCandidates(finalizationError)).toContain(fixture.lostTerminal);
    expect(fixture.terminalWrites).toBe(1);
    expect(settled).toHaveBeenCalledOnce();
    await expect(capturing).rejects.toBe(fixture.lostTerminal);
    expect(fixture.endSessions).toBe(0);
    expect(fixture.acquisitions).toBe(1);
    expect(fixture.events).toHaveLength(1);
  } finally {
    fixture.retired = true;
    await Promise.allSettled([capturing, finalizeDebugProxyCaptureAsync(settings)]);
    await response.body?.cancel();
  }
});
