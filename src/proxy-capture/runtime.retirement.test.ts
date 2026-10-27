import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { collectNestedErrorCandidates } from "../infra/error-graph-internal.js";
import { resolveDebugProxySettings } from "./env.js";
import { captureHttpExchangeAsync, finalizeDebugProxyCaptureAsync } from "./runtime.js";
import { createDebugProxyCaptureStoreForContext } from "./store.async.js";
import * as synchronousStore from "./store.sqlite.js";
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

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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
      recordEventWithPayload: fixture.record,
      endSession: fixture.endSession,
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
  const synchronous = vi.spyOn(synchronousStore, "getDebugProxyCaptureStore");
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("capture-retirement-"));
  const settings = {
    ...resolveDebugProxySettings(),
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

    const error = await finalizeDebugProxyCaptureAsync(settings).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AggregateError);
    expect(collectNestedErrorCandidates(error)).toContain(fixture.failure);
    expect(settled).toHaveBeenCalledOnce();
    await expect(capturing).rejects.toBe(fixture.failure);
    expect(fixture.record.mock.calls.map(([event]) => event.kind)).toEqual(["request", "response"]);
    expect(fixture.endSession).not.toHaveBeenCalled();
    expect(createDebugProxyCaptureStoreForContext).toHaveBeenCalledOnce();
    expect(synchronous).not.toHaveBeenCalled();
  } finally {
    fixture.state.retired = true;
    await Promise.allSettled([capturing, finalizeDebugProxyCaptureAsync(settings)]);
    await response.body?.cancel();
  }
});
