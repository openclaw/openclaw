import { expect, it, vi } from "vitest";
import { collectNestedErrorCandidates } from "../infra/error-graph-internal.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { resolveDebugProxySettings } from "./env.js";
import { captureHttpExchangeAsync, finalizeDebugProxyCaptureAsync } from "./runtime.js";
import { createDebugProxyCaptureStoreForContext } from "./store.async.js";
import type { CaptureEventRecord } from "./types.js";

const fixture = vi.hoisted(() => {
  const accepted = Promise.withResolvers<void>();
  const failure = new Error("Retired capture lost its terminal write");
  const state = { retired: false };
  const record = vi.fn(async (_event: CaptureEventRecord) => {
    if (state.retired) {
      throw failure;
    }
    accepted.resolve();
  });
  return { state, accepted, failure, record, endSession: vi.fn().mockRejectedValue(failure) };
});

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

vi.mock("./store.sqlite.js", () => {
  const forbidden = () => {
    throw new Error("Retired capture must not use synchronous storage");
  };
  return {
    getDebugProxyCaptureStore: forbidden,
    persistEventPayload: forbidden,
    safeJsonString: JSON.stringify,
  };
});

// mock-isolation: Drive retirement and lost terminal writes without opening a capture database.
vi.mock("./store.async.js", () => ({
  createDebugProxyCaptureStoreForContext: vi.fn(() => {
    const release = async () => {
      expect(fixture.state.retired, "canonical retirement precedes lease release").toBe(true);
    };
    const store = {
      get isClosed() {
        return fixture.state.retired;
      },
      recordEvent: fixture.record,
      recordEventWithPayload: fixture.record,
      endSession: fixture.endSession,
      close: release,
    };
    return {
      store,
      ready: Promise.resolve(),
      runOperation: <T>(operation: (scope: typeof store) => Promise<T>) => operation(store),
      release,
    };
  }),
}));

it("settles accepted capture and reports lost terminal writes after canonical retirement", async () => {
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
    await fixture.accepted.promise;
    expect(fixture.record.mock.calls.map(([event]) => event.kind)).toEqual(["request"]);
    expect(settled).not.toHaveBeenCalled();
    fixture.state.retired = true;

    const finalizationError = await finalizeDebugProxyCaptureAsync(settings).catch(
      (error: unknown) => error,
    );
    expect(finalizationError).toBeInstanceOf(AggregateError);
    expect(collectNestedErrorCandidates(finalizationError)).toContain(fixture.failure);
    expect(settled).toHaveBeenCalledOnce();
    await expect(capturing).rejects.toBe(fixture.failure);
    expect(fixture.record.mock.calls.map(([event]) => event.kind)).toEqual(["request", "response"]);
    expect(fixture.endSession).not.toHaveBeenCalled();
    expect(createDebugProxyCaptureStoreForContext).toHaveBeenCalledOnce();
  } finally {
    fixture.state.retired = true;
    await Promise.allSettled([capturing, finalizeDebugProxyCaptureAsync(settings)]);
    await response.body?.cancel();
  }
});
